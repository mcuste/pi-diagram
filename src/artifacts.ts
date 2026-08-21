import { randomUUID } from "node:crypto";
import {
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
import { DiagramSourceError } from "./d2/diagnostics.js";

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
  txt: ".txt",
} as const;

export type ArtifactFormat = keyof typeof EXTENSIONS;

/** Editable source plus a viewable rendering, which is what ADR-009 asks documentation to keep. */
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
    if (format === "png") {
      refuse(
        "PNG artifacts are not available.",
        "D2 renders PNG by driving a headless browser, which it downloads on first use.",
        "Save `svg` instead. It needs no browser and scales better in documentation.",
      );
    }
    if (format !== "source" && format !== "svg" && format !== "txt") {
      refuse(
        "Diagram save formats are not usable.",
        `${JSON.stringify(format)} is not a format.`,
        "Use source, svg, or txt.",
      );
    }
    if (!formats.includes(format)) {
      formats.push(format);
    }
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
        : `Expected a path, got ${typeof requested}.`,
      "Name the directory to write into, such as docs/diagrams.",
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
      `${JSON.stringify(requested)} is an absolute path.`,
      "Give a path relative to the workspace, such as docs/diagrams.",
    );
  }
  const segments = directory.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.includes("..")) {
    refuse(
      "Diagram save directory is not usable.",
      `${JSON.stringify(requested)} climbs out of the workspace.`,
      "Give a path inside the workspace.",
    );
  }
  return segments.length === 0 ? "." : segments.join("/");
}

function parseSave(requested: unknown): { readonly directory: string; readonly basename: unknown } {
  if (typeof requested !== "object" || requested === null || Array.isArray(requested)) {
    refuse("Diagram save options are not usable.", `Expected an object, got ${typeof requested}.`);
  }
  return {
    directory: parseDirectory(Reflect.get(requested, "dir")),
    basename: Reflect.get(requested, "basename"),
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
  fallback: string | undefined,
): SafeBasename {
  const chosen = typeof requested === "string" && requested.trim().length > 0 ? requested : title;
  if (chosen === undefined) {
    if (fallback !== undefined) {
      return fallback as SafeBasename;
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
      `${JSON.stringify(chosen)} has no letters or digits to build a file name from.`,
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
  readonly hash: string;
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
  const fallback = save === undefined ? `diagram-${identity.hash.slice(0, 12)}` : undefined;
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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

/**
 * `mkdtemp` creates the directory owner-only, so diagrams that quote repository content are not
 * readable by other users of a shared machine.
 */
function sessionDirectory(): Promise<string> {
  sessionStore ??= mkdtemp(join(tmpdir(), "pi-diagram-store-"));
  return sessionStore;
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
      `The host gave ${JSON.stringify(cwd)}.`,
    );
  }

  const root = resolve(cwd);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    refuse(
      "The workspace directory cannot be read.",
      `${root} could not be resolved: ${(error as Error).message}.`,
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

/**
 * Writes each artifact through a temporary file and a rename, so a reader never sees a half
 * written diagram and a failed render leaves the previous version in place.
 */
export async function writeArtifacts(
  target: ArtifactTarget,
  contents: ReadonlyMap<ArtifactFormat, string>,
): Promise<readonly WrittenArtifact[]> {
  await mkdir(target.directory, { recursive: true });
  if (target.location === "workspace") {
    // The directory exists now, so this catches a link created between the check and the write.
    await assertInsideWorkspace(target.root, target.directory);
  }

  const written: WrittenArtifact[] = [];
  for (const format of target.names.formats) {
    const content = contents.get(format);
    if (content === undefined) {
      continue;
    }

    const destination = join(target.directory, `${target.names.basename}${EXTENSIONS[format]}`);
    await assertWritable(destination);
    const temporary = join(target.directory, `.${target.names.basename}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o644 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    written.push({
      format,
      location: target.location,
      path:
        target.location === "workspace"
          ? relative(target.root, destination).split(sep).join("/")
          : destination,
    });
  }

  if (target.location === "temp") {
    await evictOldest(target.directory);
  }
  return written;
}

/** Regenerating a diagram replaces its own files, but never anything that is not a plain file. */
async function assertWritable(destination: string): Promise<void> {
  try {
    const existing = await lstat(destination);
    if (!existing.isFile()) {
      refuse(
        "That diagram path cannot be written.",
        `${destination} already exists and is not a regular file.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
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
