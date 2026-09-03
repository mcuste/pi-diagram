import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandCancelledError,
  CommandInvocationError,
  CommandOutputLimitError,
  type CommandResult,
  type CommandRunner,
  CommandTimeoutError,
  cacheKey,
  type Diagnostic,
  DiagramSourceError,
  FileCache,
  findTerminalControl,
  parseSafeSvg,
  type RenderCache,
  runCommand,
  SvgOutputError,
} from "@mcuste/pi-diagram-core";
import { parseD2Diagnostics } from "./diagnostics.js";
import type { LayoutPolicy, RenderProfile } from "./profiles.js";
import type { D2Source } from "./source.js";

/**
 * Runs the D2 CLI. The source reaches D2 only as a file in a fresh temporary directory: no
 * model-written string ever enters the argument list, which is built from the literals below.
 */

/**
 * 0.7.x draws `shape: sql_table` as an empty box, losing every column. The prebuilt GitHub
 * release binaries stop at 0.7.1, so the pinned path is the module tag, not a release asset.
 */
const MINIMUM_D2_VERSION = "0.8.0";
const D2_TIMEOUT_SECONDS = 10;
/** Above D2's own timeout, so D2 reports it first and this only catches a hung process. */
const PROCESS_TIMEOUT_MS = (D2_TIMEOUT_SECONDS + 5) * 1000;
const MAX_RENDER_BYTES = 1024 * 1024;
const INPUT_FILE = "input.d2";

const INSTALL_HINT =
  "Install the D2 CLI with `brew install d2` or " +
  "`go install github.com/d2lang/d2@v0.8.1`, or point D2_BIN at an existing one. Version " +
  `${MINIMUM_D2_VERSION} or newer is required.`;

export type AsciiMode = "extended" | "standard";

declare const d2ArgumentBrand: unique symbol;
declare const supportedVersionBrand: unique symbol;
declare const renderedTextBrand: unique symbol;
declare const renderedSvgBrand: unique symbol;

/** Built from this module's literals and the profile table, never from model input. */
type D2Argument = string & { readonly [d2ArgumentBrand]: true };

/** Confirmed at or above `MINIMUM_D2_VERSION`. */
export type SupportedD2Version = string & { readonly [supportedVersionBrand]: true };

/** Output that passed `parseRenderedText`, so it is safe to print. */
export type RenderedDiagramText = string & { readonly [renderedTextBrand]: true };

/** Output that passed `parseRenderedSvg`, so it is safe to write into the workspace. */
export type RenderedSvg = string & { readonly [renderedSvgBrand]: true };

export interface D2TextRequest {
  readonly source: D2Source;
  readonly asciiMode: AsciiMode;
  readonly signal: AbortSignal | undefined;
}

export interface D2Text {
  readonly text: RenderedDiagramText;
  readonly version: SupportedD2Version;
}

export interface D2SvgRequest {
  readonly source: D2Source;
  readonly profile: RenderProfile;
  readonly signal: AbortSignal | undefined;
}

export interface D2Svg {
  readonly svg: RenderedSvg;
  readonly version: SupportedD2Version;
}

export interface D2FormatRequest {
  readonly source: D2Source;
  readonly signal: AbortSignal | undefined;
}

export interface D2Renderer {
  renderText(request: D2TextRequest): Promise<D2Text>;
  renderSvg(request: D2SvgRequest): Promise<D2Svg>;
  /** The same source as `d2 fmt` writes it. Throws when D2 will not format it. */
  formatSource(request: D2FormatRequest): Promise<string>;
}

/** The user has to fix this by installing D2. Retrying the call will not help. */
class D2UnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`${message} ${INSTALL_HINT}`, { ...options });
    this.name = "D2UnavailableError";
  }
}

/** D2 accepted the source but drew nothing usable. Not the model's mistake to correct. */
export class TextRenderUnavailableError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[] = []) {
    super(message);
    this.name = "TextRenderUnavailableError";
    this.diagnostics = diagnostics;
  }
}

/** The text representation remains usable when an optional SVG cannot be produced. */
export class SvgRenderUnavailableError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[] = []) {
    super(message);
    this.name = "SvgRenderUnavailableError";
    this.diagnostics = diagnostics;
  }
}

/** Formatting is optional, but source syntax and cancellation are not. */
export class SourceFormatUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceFormatUnavailableError";
  }
}

function args(...values: readonly string[]): readonly D2Argument[] {
  return values as readonly D2Argument[];
}

/** No theme or spacing: D2 draws text in character cells, which neither one changes. */
function renderArguments(mode: AsciiMode): readonly D2Argument[] {
  return args(
    "--layout",
    "elk",
    "--timeout",
    String(D2_TIMEOUT_SECONDS),
    "--ascii-mode",
    mode,
    "--stdout-format",
    "ascii",
    INPUT_FILE,
    "-",
  );
}

function svgArguments(profile: RenderProfile): readonly D2Argument[] {
  return args(
    "--layout",
    profile.layout.engine,
    ...spacingArguments(profile.layout),
    ...(profile.sketch ? ["--sketch"] : []),
    "--theme",
    String(profile.theme),
    "--dark-theme",
    String(profile.darkTheme),
    "--pad",
    String(profile.padPx),
    "--timeout",
    String(D2_TIMEOUT_SECONDS),
    "--stdout-format",
    "svg",
    INPUT_FILE,
    "-",
  );
}

/** `d2 fmt` rewrites the file it is given, so there is no output format to ask for. */
const FORMAT_ARGUMENTS = args("fmt", INPUT_FILE);

function spacingArguments(layout: LayoutPolicy): readonly string[] {
  if (layout.engine === "dagre") {
    return [
      "--dagre-nodesep",
      String(layout.nodeGapPx),
      "--dagre-edgesep",
      String(layout.edgeGapPx),
    ];
  }
  const pad = layout.containerPadPx;
  return [
    "--elk-nodeNodeBetweenLayers",
    String(layout.layerGapPx),
    "--elk-edgeNodeBetweenLayers",
    String(layout.edgeGapPx),
    "--elk-padding",
    `[top=${pad},left=${pad},bottom=${pad},right=${pad}]`,
  ];
}

/** D2 reports strings such as `v0.8.1-HEAD`, so only the three numbers are compared. */
export function parseD2Version(result: CommandResult): SupportedD2Version {
  const raw = (result.stdout.trim() || result.stderr.trim()).split("\n")[0]?.trim() ?? "";
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]*)?$/u.exec(raw);
  if (findTerminalControl(raw) !== undefined || !match || result.exitCode !== 0) {
    throw new D2UnavailableError(
      `Could not read a version from D2 (${raw ? JSON.stringify(raw) : "no output"}).`,
    );
  }

  const found = triple(match[1], match[2], match[3]);
  if (found === undefined) {
    throw new D2UnavailableError(`Could not read a version from D2 (${JSON.stringify(raw)}).`);
  }
  if (isBelow(found, MINIMUM_VERSION)) {
    throw new D2UnavailableError(`D2 ${raw} is installed, which is too old.`);
  }
  return raw as SupportedD2Version;
}

const MINIMUM_VERSION = versionOf(MINIMUM_D2_VERSION);

type Version = readonly [number, number, number];

function versionOf(value: string): Version {
  const parts = value.split(".");
  const version = triple(parts[0], parts[1], parts[2]);
  if (version === undefined) {
    throw new Error(`Not a three-part version: ${JSON.stringify(value)}.`);
  }
  return version;
}

function triple(
  major: string | undefined,
  minor: string | undefined,
  patch: string | undefined,
): Version | undefined {
  const numbers = [major, minor, patch].map((part) => Number(part));
  const [first, second, third] = numbers;
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    !numbers.every((part) => Number.isSafeInteger(part) && part >= 0)
  ) {
    return undefined;
  }
  return [first, second, third];
}

function isBelow(found: Version, minimum: Version): boolean {
  const [foundMajor, foundMinor, foundPatch] = found;
  const [minMajor, minMinor, minPatch] = minimum;
  if (foundMajor !== minMajor) {
    return foundMajor < minMajor;
  }
  if (foundMinor !== minMinor) {
    return foundMinor < minMinor;
  }
  return foundPatch < minPatch;
}

/**
 * D2 exiting zero does not mean the output is usable: the beta text renderer returns blank
 * drawings, and a silently ignored mode flag would otherwise reach the terminal unnoticed.
 */
export function parseRenderedText(raw: string, mode: AsciiMode): RenderedDiagramText {
  const text = raw
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n+$/u, "");
  if (text.trim().length === 0) {
    throw new TextRenderUnavailableError("D2 produced an empty text diagram.");
  }

  const control = findTerminalControl(text, true);
  if (control !== undefined) {
    throw new TextRenderUnavailableError(
      `D2 text output contains a control character (U+${control.codePoint.toString(16).padStart(4, "0").toUpperCase()}).`,
    );
  }
  if (mode === "standard" && /[^\x20-\x7e\n]/u.test(text)) {
    throw new TextRenderUnavailableError(
      "D2 returned a non-ASCII character in standard ASCII mode.",
    );
  }

  const drew =
    mode === "standard" ? /[+\-|]/u.test(text) : /[\u2500-\u257F\u25A0-\u25FF]/u.test(text);
  if (!drew) {
    throw new TextRenderUnavailableError("D2 text output contains no diagram lines or boxes.");
  }
  return text as RenderedDiagramText;
}

/**
 * A render is only safe after XML parsing and a static SVG policy accept every node, attribute,
 * and stylesheet URL.
 */
export function parseRenderedSvg(raw: string): RenderedSvg {
  try {
    return parseSafeSvg(raw) as RenderedSvg;
  } catch (error) {
    if (error instanceof SvgOutputError) {
      throw new SvgRenderUnavailableError(error.message);
    }
    throw error;
  }
}

/** Bounds what one session remembers about sources D2 already accepted. */
const MAX_VALIDATED = 256;

export class D2Cli implements D2Renderer {
  private readonly runner: CommandRunner;
  private readonly binary: string;
  private readonly cache: RenderCache;
  private version: SupportedD2Version | undefined;
  /** Cache keys of sources this process has compiled, so one call validates them once. */
  private readonly validated = new Set<string>();

  constructor(dependencies: { runner?: CommandRunner; binary?: string; cache?: RenderCache } = {}) {
    this.runner = dependencies.runner ?? runCommand;
    this.binary = dependencies.binary ?? parseBinaryName(process.env.D2_BIN);
    this.cache = dependencies.cache ?? new FileCache();
  }

  async renderText(request: D2TextRequest): Promise<D2Text> {
    const { output, version } = await this.compile(request.source, request.signal, {
      argv: renderArguments(request.asciiMode),
      parse: (stdout) => parseRenderedText(stdout, request.asciiMode),
      failure: "D2 could not draw this diagram as text.",
    });
    return { text: output, version };
  }

  async renderSvg(request: D2SvgRequest): Promise<D2Svg> {
    const { output, version } = await this.compile(request.source, request.signal, {
      argv: svgArguments(request.profile),
      parse: parseRenderedSvg,
      failure: "D2 could not draw this diagram as an SVG.",
      unavailable: (message, diagnostics) => new SvgRenderUnavailableError(message, diagnostics),
    });
    return { svg: output, version };
  }

  /** The formatted source is read back from the temp directory, since `fmt` writes no stdout. */
  async formatSource(request: D2FormatRequest): Promise<string> {
    const version = await this.ensureVersion(request.signal);
    const key = cacheKey({
      source: request.source,
      language: "d2",
      binary: this.binary,
      version,
      argv: FORMAT_ARGUMENTS,
    });
    const stored = await this.cache.read(key);
    if (stored !== undefined) {
      return stored;
    }

    const directory = await mkdtemp(join(tmpdir(), "pi-diagram-"));
    try {
      const path = join(directory, INPUT_FILE);
      await writeFile(path, `${request.source}\n`, "utf8");
      const result = await this.run(FORMAT_ARGUMENTS, directory, request.signal);
      if (result.exitCode !== 0) {
        throw new SourceFormatUnavailableError("D2 could not format this source.", {
          cause: new DiagramSourceError(
            "D2 could not format this source.",
            parseD2Diagnostics(result.stderr, "D2_RENDER", [directory]),
          ),
        });
      }
      const formatted = await readFile(path, "utf8");
      await this.cache.write(key, formatted);
      return formatted;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async compile<TOutput>(
    source: D2Source,
    signal: AbortSignal | undefined,
    step: {
      readonly argv: readonly D2Argument[];
      readonly parse: (stdout: string) => TOutput;
      readonly failure: string;
      readonly unavailable?: (message: string, diagnostics: readonly Diagnostic[]) => Error;
    },
  ): Promise<{ output: TOutput; version: SupportedD2Version }> {
    const version = await this.ensureVersion(signal);
    if (signal?.aborted === true) {
      // A cached answer would otherwise come back after the call was given up on.
      throw new CommandCancelledError("Drawing the diagram");
    }

    const identity = { source, language: "d2", binary: this.binary, version } as const;
    const key = cacheKey({ ...identity, argv: step.argv });
    // No arguments: what D2 accepts depends on the source and the version, not on the flags.
    const compiles = cacheKey({ ...identity, argv: [] });
    const stored = await this.cache.read(key);
    if (stored !== undefined) {
      try {
        const output = step.parse(stored);
        this.remember(compiles);
        return { output, version };
      } catch {
        // An entry this build cannot read is no better than a missing one.
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "pi-diagram-"));
    try {
      await writeFile(join(directory, INPUT_FILE), `${source}\n`, "utf8");
      if (!this.validated.has(compiles)) {
        await this.validate(directory, signal);
      }
      const rendered = await this.run(step.argv, directory, signal);
      if (rendered.exitCode !== 0) {
        const diagnostics = parseD2Diagnostics(rendered.stderr, "D2_RENDER", [directory]);
        throw (
          step.unavailable?.(step.failure, diagnostics) ??
          new TextRenderUnavailableError(step.failure, diagnostics)
        );
      }
      const output = step.parse(rendered.stdout);
      this.remember(compiles);
      await this.cache.write(key, rendered.stdout);
      return { output, version };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private remember(key: string): void {
    if (this.validated.size >= MAX_VALIDATED) {
      this.validated.clear();
    }
    this.validated.add(key);
  }

  private async validate(directory: string, signal: AbortSignal | undefined): Promise<void> {
    const result = await this.run(args("validate", INPUT_FILE), directory, signal);
    if (result.exitCode !== 0) {
      throw new DiagramSourceError(
        "D2 could not compile this source.",
        parseD2Diagnostics(result.stderr, "D2_SYNTAX", [directory]),
      );
    }
  }

  private async ensureVersion(signal: AbortSignal | undefined): Promise<SupportedD2Version> {
    if (this.version !== undefined) {
      return this.version;
    }
    // Deliberately not cached on failure, so installing D2 mid-session starts working.
    const result = await this.run(args("--version"), tmpdir(), signal);
    this.version = parseD2Version(result);
    return this.version;
  }

  private async run(
    argv: readonly D2Argument[],
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<CommandResult> {
    try {
      return await this.runner(this.binary, argv, {
        cwd,
        signal,
        // D2 renders correctly with an empty environment. PATH is here only so a bare
        // command name resolves.
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: PROCESS_TIMEOUT_MS,
        maxOutputBytes: MAX_RENDER_BYTES,
      });
    } catch (error) {
      throw translate(error, this.binary);
    }
  }
}

function translate(error: unknown, binary: string): unknown {
  if (error instanceof CommandCancelledError) {
    return error;
  }
  if (error instanceof CommandInvocationError) {
    return new D2UnavailableError(`Could not run ${JSON.stringify(binary)}.`, { cause: error });
  }
  if (error instanceof CommandTimeoutError) {
    return new DiagramSourceError("Rendering this diagram took too long.", [
      {
        code: "D2_TIMEOUT",
        message: `D2 did not finish within ${D2_TIMEOUT_SECONDS} seconds.`,
        hint: "Use fewer nodes, or split the diagram.",
      },
    ]);
  }
  if (error instanceof CommandOutputLimitError) {
    return new DiagramSourceError("The rendered diagram is too large.", [
      {
        code: "D2_TOO_LARGE",
        message: `D2 produced more than ${MAX_RENDER_BYTES} bytes.`,
        hint: "Use fewer nodes, or split the diagram.",
      },
    ]);
  }
  return error;
}

/**
 * `D2_BIN` is not model input, but it still lands in an exec call, so anything that could read
 * as an option or split into extra arguments is refused.
 */
export function parseBinaryName(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    return "d2";
  }
  const binary = value.trim();
  if (binary.startsWith("-") || /[\s"'`$;&|<>]/u.test(binary)) {
    throw new D2UnavailableError(`D2_BIN is not a usable command: ${JSON.stringify(value)}.`);
  }
  return binary;
}
