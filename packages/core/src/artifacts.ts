import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DiagramSourceError, describeInvalidValue } from "./diagnostics.js";
import { throwIfCancelled } from "./process.js";
import { describeCodePoint, findTerminalControl, safeErrorMessage } from "./terminal.js";

/**
 * Writes diagram artifacts. Files land in a private temporary directory unless a call names a
 * repository destination, because most diagrams explain something in passing and have no
 * business being committed.
 */

const MAX_BASENAME_LENGTH = 60;
const MAX_DIRECTORY_LENGTH = 255;
/** Keeps a long session from filling the temp directory with diagrams nobody opened. */
const MAX_TEMP_FILES = 64;

const EXTENSIONS = {
  source: ".d2",
  svg: ".svg",
  png: ".png",
  txt: ".txt",
} as const;

export type ArtifactFormat = keyof typeof EXTENSIONS;

/** Editable source plus a viewable rendering. */
const DEFAULT_FORMATS: readonly ArtifactFormat[] = ["source", "svg"];

/** Names Windows treats as devices rather than files, whatever extension follows. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

declare const safeBasenameBrand: unique symbol;
declare const artifactDirectoryBrand: unique symbol;

/** A file name stem with no path separators, extension, or reserved meaning. */
type SafeBasename = string & { readonly [safeBasenameBrand]: true };

/** An absolute directory that is either the session temp store or inside the workspace root. */
type ArtifactDirectory = string & { readonly [artifactDirectoryBrand]: true };

type ArtifactLocation = "temp" | "workspace";

declare const sourceHashBrand: unique symbol;

/** A SHA-256 digest of normalized diagram source. */
export type SourceHash = string & { readonly [sourceHashBrand]: true };

/** Parses a digest before it becomes part of an artifact file name. */
export function parseSourceHash(raw: unknown): SourceHash {
  if (typeof raw === "string" && /^[a-f0-9]{64}$/u.test(raw)) {
    return raw as SourceHash;
  }
  throw new DiagramSourceError("Diagram source hash is not usable.", [
    { code: "D2_SOURCE", message: `Expected a SHA-256 digest, got ${describeInvalidValue(raw)}.` },
  ]);
}

export interface ArtifactNames {
  /** Workspace-relative destination, or `undefined` to keep the files out of the repository. */
  readonly directory: string | undefined;
  readonly basename: SafeBasename;
  readonly formats: readonly ArtifactFormat[];
}

export interface ArtifactTarget {
  readonly location: ArtifactLocation;
  readonly directory: ArtifactDirectory;
  readonly names: ArtifactNames;
  readonly root: string;
}

export interface WrittenArtifact {
  readonly format: ArtifactFormat;
  readonly location: ArtifactLocation;
  /** Workspace-relative for a repository file, absolute for a temporary one. */
  readonly path: string;
}

function refuse(summary: string, message: string, hint?: string): never {
  throw new DiagramSourceError(summary, [
    { code: "D2_SOURCE", message, ...(hint === undefined ? {} : { hint }) },
  ]);
}

function parseFormats(requested: unknown): readonly ArtifactFormat[] {
  if (requested === undefined) {
    return DEFAULT_FORMATS;
  }
  if (!Array.isArray(requested) || requested.length === 0) {
    refuse(
      "Diagram save formats are not usable.",
      `Expected a non-empty list, got ${typeof requested}.`,
    );
  }

  const formats: ArtifactFormat[] = [];
  for (const format of requested) {
    if (typeof format !== "string" || !Object.hasOwn(EXTENSIONS, format)) {
      refuse(
        "Diagram save formats are not usable.",
        `${describeInvalidValue(format)} is not a format.`,
        `Use ${Object.keys(EXTENSIONS).join(", ")}.`,
      );
    }
    const parsed = format as ArtifactFormat;
    if (formats.includes(parsed)) {
      refuse(
        "Diagram save formats are not usable.",
        `${describeInvalidValue(format)} appears more than once.`,
      );
    }
    formats.push(parsed);
  }
  return formats;
}

/** A repository destination has to be named. There is no directory convention worth assuming. */
function parseDirectory(requested: unknown): string {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    refuse(
      "Saving a diagram needs a directory.",
      requested === undefined
        ? "`save.dir` was not given."
        : `Expected a non-empty path, got ${describeInvalidValue(requested)}.`,
      "Name the directory to write into, such as docs/diagrams.",
    );
  }

  const control = findTerminalControl(requested);
  if (control !== undefined) {
    refuse(
      "Diagram save directory is not usable.",
      `${describeCodePoint(control.codePoint)} at offset ${control.offset} is not allowed in a path.`,
    );
  }

  const directory = requested.trim().replaceAll("\\", "/");
  if (directory.length > MAX_DIRECTORY_LENGTH) {
    refuse(
      "Diagram save directory is not usable.",
      `It is longer than ${MAX_DIRECTORY_LENGTH} characters.`,
    );
  }
  if (isAbsolute(requested) || directory.startsWith("/")) {
    refuse(
      "Diagram save directory is not usable.",
      `${describeInvalidValue(requested)} is an absolute path.`,
      "Give a path relative to the workspace, such as docs/diagrams.",
    );
  }
  const segments = directory.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.includes("..")) {
    refuse(
      "Diagram save directory is not usable.",
      `${describeInvalidValue(requested)} climbs out of the workspace.`,
      "Give a path inside the workspace.",
    );
  }
  return segments.length === 0 ? "." : segments.join("/");
}

function parseSave(requested: unknown): { readonly directory: string; readonly basename: unknown } {
  if (typeof requested !== "object" || requested === null || Array.isArray(requested)) {
    refuse(
      "Diagram save options are not usable.",
      `Expected an object, got ${describeInvalidValue(requested)}.`,
    );
  }
  const keys = Object.keys(requested);
  if (keys.some((key) => key !== "dir" && key !== "basename")) {
    refuse("Diagram save options are not usable.", "Only `dir` and `basename` are supported.");
  }
  if (!Object.hasOwn(requested, "dir")) {
    refuse("Saving a diagram needs a directory.", "`save.dir` was not given.");
  }
  return {
    directory: parseDirectory(Reflect.get(requested, "dir")),
    basename: Object.hasOwn(requested, "basename") ? Reflect.get(requested, "basename") : undefined,
  };
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, MAX_BASENAME_LENGTH)
    .replace(/-+$/u, "");
}

/**
 * A repository file needs a name someone chose, so regenerating the diagram lands on the same
 * path. A temporary file falls back to the source hash, so an ad-hoc diagram needs no title.
 */
function parseBasename(
  requested: unknown,
  title: string | undefined,
  fallback: SafeBasename | undefined,
): SafeBasename {
  let chosen = title;
  if (requested !== undefined) {
    if (typeof requested !== "string" || requested.trim().length === 0) {
      refuse(
        "A saved diagram needs a usable name.",
        `Expected a non-empty string, got ${describeInvalidValue(requested)}.`,
      );
    }
    chosen = requested;
  }
  if (chosen === undefined) {
    if (fallback !== undefined) {
      return fallback;
    }
    refuse(
      "A diagram saved into the repository needs a name.",
      "Neither `save.basename` nor `title` was given.",
      "Add a title so the file keeps the same name when the diagram is regenerated.",
    );
  }

  const basename = slugify(chosen);
  if (basename.length === 0) {
    refuse(
      "A saved diagram needs a usable name.",
      `${describeInvalidValue(chosen)} has no letters or digits to build a file name from.`,
    );
  }
  if (RESERVED_NAMES.has(basename)) {
    refuse("A saved diagram needs a different name.", `${basename} is a reserved device name.`);
  }
  return basename as SafeBasename;
}

export interface ArtifactIdentity {
  readonly title: string | undefined;
  /** Hash of the normalized source, used to name a temporary file with no title. */
  readonly hash: unknown;
}
export interface ArtifactAsk {
  /** Which artifacts to produce. They land in the temp store either way. */
  readonly formats?: unknown;
  /** Present only when the caller also wants them in the repository. */
  readonly save?: unknown;
}

/** Resolves nothing on disk, so a bad request is refused before any rendering starts. */
export function parseArtifactNames(
  request: ArtifactAsk,
  identity: ArtifactIdentity,
): ArtifactNames {
  const save = request.save === undefined ? undefined : parseSave(request.save);
  const fallback =
    save === undefined
      ? (`diagram-${parseSourceHash(identity.hash).slice(0, 12)}` as SafeBasename)
      : undefined;
  return {
    directory: save?.directory,
    basename: parseBasename(save?.basename, identity.title, fallback),
    formats: parseFormats(request.formats),
  };
}

/** The workspace-relative paths a repository write would touch, for an approval prompt. */
export function workspacePaths(names: ArtifactNames): readonly string[] {
  if (names.directory === undefined) {
    return [];
  }
  const prefix = names.directory === "." ? "" : `${names.directory}/`;
  return names.formats.map((format) => `${prefix}${names.basename}${EXTENSIONS[format]}`);
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Checks whether a system error has a given code. */
function hasSystemErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === code;
}

/**
 * Checks the deepest existing ancestor, before any directory is created: a `docs` symlink
 * pointing outside would otherwise have `mkdir` build the rest of the path beyond it.
 */
async function assertInsideWorkspace(realRoot: string, target: string): Promise<void> {
  if (!contains(realRoot, target)) {
    refuse(
      "Diagram save directory is outside the workspace.",
      `${target} is not inside ${realRoot}.`,
    );
  }

  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!contains(realRoot, real)) {
        refuse(
          "Diagram save directory leaves the workspace.",
          `${probe} resolves to ${real}, outside ${realRoot}.`,
          "A symbolic link on that path points outside the workspace.",
        );
      }
      return;
    } catch (error) {
      if (!hasSystemErrorCode(error, "ENOENT")) {
        throw error;
      }
      const parent = dirname(probe);
      if (parent === probe) {
        refuse("Diagram save directory is not usable.", `No part of ${target} exists.`);
      }
      probe = parent;
    }
  }
}

let sessionStore: Promise<string> | undefined;
let sessionStorePath: string | undefined;

/**
 * `mkdtemp` creates the directory owner-only, so diagrams that quote repository content are not
 * readable by other users of a shared machine.
 */
function sessionDirectory(): Promise<string> {
  sessionStore ??= mkdtemp(join(tmpdir(), "pi-diagram-store-")).then(
    (directory) => {
      sessionStorePath = directory;
      return directory;
    },
    (error) => {
      sessionStore = undefined;
      throw error;
    },
  );
  return sessionStore;
}

/** Result renderers may only read images this process stored in its private directory. */
export function isSessionArtifactPath(path: string): boolean {
  return sessionStorePath !== undefined && contains(sessionStorePath, resolve(path));
}

export async function parseArtifactTarget(
  cwd: unknown,
  names: ArtifactNames,
): Promise<ArtifactTarget> {
  if (names.directory === undefined) {
    const directory = await sessionDirectory();
    return { location: "temp", directory: directory as ArtifactDirectory, names, root: directory };
  }

  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) {
    refuse(
      "Diagrams cannot be saved into a repository without a workspace directory.",
      `The host gave ${describeInvalidValue(cwd)}.`,
    );
  }

  const root = resolve(cwd);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    refuse(
      "The workspace directory cannot be read.",
      `${root} could not be resolved: ${safeErrorMessage(error)}.`,
    );
  }

  const directory = resolve(realRoot, names.directory);
  await assertInsideWorkspace(realRoot, directory);
  return {
    location: "workspace",
    directory: directory as ArtifactDirectory,
    names,
    root: realRoot,
  };
}

interface StagedArtifact {
  readonly format: ArtifactFormat;
  readonly destination: string;
  readonly temporary: string;
  readonly previous: Stats | undefined;
  backup: string | undefined;
  committed: boolean;
}

/** Stage every artifact before replacing files, so one bad destination cannot leave a partial set. */
export async function writeArtifacts(
  target: ArtifactTarget,
  contents: ReadonlyMap<ArtifactFormat, string | Uint8Array>,
  signal?: AbortSignal,
): Promise<readonly WrittenArtifact[]> {
  throwIfCancelled(signal, "Writing diagram artifacts");
  await mkdir(target.directory, { recursive: true });
  if (target.location === "workspace") {
    // The directory exists now, so this catches a link created between the check and the write.
    await assertInsideWorkspace(target.root, target.directory);
  }

  const staged: StagedArtifact[] = [];
  let committed = false;
  try {
    for (const format of target.names.formats) {
      const content = contents.get(format);
      if (content === undefined) {
        continue;
      }

      throwIfCancelled(signal, "Writing diagram artifacts");
      const destination = join(target.directory, `${target.names.basename}${EXTENSIONS[format]}`);
      const temporary = join(target.directory, `.${target.names.basename}.${randomUUID()}.tmp`);
      const previous = await snapshotWritable(destination);
      await writeFile(temporary, content, {
        ...(typeof content === "string" ? { encoding: "utf8" as const } : {}),
        flag: "wx",
        mode: 0o644,
      });
      staged.push({
        format,
        destination,
        temporary,
        previous,
        backup: undefined,
        committed: false,
      });
    }

    for (const artifact of staged) {
      throwIfCancelled(signal, "Writing diagram artifacts");
      await assertUnchanged(artifact);
      if (artifact.previous === undefined) {
        // A hard link fails when another process creates the destination. `rename` would overwrite it.
        await link(artifact.temporary, artifact.destination);
        artifact.committed = true;
        await rm(artifact.temporary);
      } else {
        const backup = `${artifact.destination}.${randomUUID()}.bak`;
        await rename(artifact.destination, backup);
        artifact.backup = backup;
        await rename(artifact.temporary, artifact.destination);
        artifact.committed = true;
      }
    }
    committed = true;
  } catch (error) {
    const restorationFailures = await restoreArtifacts(staged);
    if (restorationFailures.length > 0) {
      throw new AggregateError(
        [error, ...restorationFailures],
        "Artifact commit failed and rollback left recovery files beside the affected artifacts.",
      );
    }
    throw error;
  } finally {
    await Promise.all(
      staged.flatMap((artifact) => [
        rm(artifact.temporary, { force: true }).catch(() => undefined),
        artifact.backup === undefined || !committed
          ? Promise.resolve()
          : rm(artifact.backup, { force: true }).catch(() => undefined),
      ]),
    );
  }

  if (target.location === "temp") {
    await evictOldest(target.directory).catch(() => undefined);
  }
  return staged.map((artifact) => ({
    format: artifact.format,
    location: target.location,
    path:
      target.location === "workspace"
        ? relative(target.root, artifact.destination).split(sep).join("/")
        : artifact.destination,
  }));
}

/** Regenerating a diagram replaces its own files, but never a symlink or another file type. */
async function snapshotWritable(destination: string): Promise<Stats | undefined> {
  try {
    const existing = await lstat(destination);
    if (!existing.isFile()) {
      refuse(
        "That diagram path cannot be written.",
        `${destination} already exists and is not a regular file.`,
      );
    }
    return existing;
  } catch (error) {
    if (hasSystemErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/** A path that changed after staging no longer belongs to this operation. */
async function assertUnchanged(artifact: StagedArtifact): Promise<void> {
  const current = await snapshotWritable(artifact.destination);
  if (artifact.previous === undefined && current === undefined) {
    return;
  }
  if (
    artifact.previous !== undefined &&
    current !== undefined &&
    artifact.previous.dev === current.dev &&
    artifact.previous.ino === current.ino
  ) {
    return;
  }
  refuse(
    "That diagram path changed while artifacts were being prepared.",
    `${artifact.destination} no longer matches the file this operation inspected.`,
  );
}

/** Restores each artifact or preserves its backup for manual recovery. */
async function restoreArtifacts(staged: readonly StagedArtifact[]): Promise<readonly Error[]> {
  const failures: Error[] = [];
  for (const artifact of [...staged].reverse()) {
    try {
      if (artifact.committed) {
        await rm(artifact.destination, { force: true });
      }
      if (artifact.backup !== undefined) {
        await rename(artifact.backup, artifact.destination);
        artifact.backup = undefined;
      }
    } catch (error) {
      failures.push(
        new Error(`Could not restore ${artifact.destination}; its backup was preserved.`, {
          cause: error,
        }),
      );
    }
  }
  return failures;
}

async function evictOldest(directory: string): Promise<void> {
  const names = await readdir(directory);
  if (names.length <= MAX_TEMP_FILES) {
    return;
  }

  const aged = await Promise.all(
    names.map(async (name) => {
      const path = join(directory, name);
      try {
        return { path, at: (await stat(path)).mtimeMs };
      } catch {
        return { path, at: Number.POSITIVE_INFINITY };
      }
    }),
  );
  aged.sort((left, right) => left.at - right.at);
  for (const { path } of aged.slice(0, aged.length - MAX_TEMP_FILES)) {
    await rm(path, { force: true, recursive: true });
  }
}
