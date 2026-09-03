import type { SourceHash } from "@mcuste/pi-diagram-core";
import {
  type ArtifactFormat,
  type ArtifactNames,
  type ArtifactTarget,
  type Diagnostic,
  DiagramSourceError,
  describeInvalidValue,
  ImageRenderUnavailableError,
  parseArtifactNames,
  parseArtifactTarget,
  type RasterImage,
  type StoredPng,
  safeErrorMessage,
  throwIfCancelled,
  type WrittenArtifact,
  writeArtifacts,
} from "@mcuste/pi-diagram-core";
import { type ProfileName, parseProfile, type RenderProfile } from "./profiles.js";
import { ResvgRasterizer, type SvgRasterizer } from "./raster.js";
import {
  type D2Renderer,
  type D2Svg,
  type D2Text,
  type RenderedDiagramText,
  SourceFormatUnavailableError,
  type SupportedD2Version,
  SvgRenderUnavailableError,
  TextRenderUnavailableError,
} from "./runner.js";
import type { D2Source, ParsedD2Source, SafeTitle } from "./source.js";
import { parseD2Source, parseTitle } from "./source.js";

/** D2's beta text renderer must fail rather than substitute another drawing. */
export type Representation = "unicode" | "source";

const MAX_LINES = 300;
const MAX_COLUMNS = 400;
const MAX_BYTES = 32 * 1024;
/** The terminal representation selected for display. */
type DisplayRepresentation =
  | { readonly kind: "unicode"; readonly content: RenderedDiagramText }
  | { readonly kind: "source"; readonly content: D2Source };
interface ParsedDiagramRequest {
  readonly parsedSource: ParsedD2Source;
  readonly source: D2Source;
  readonly title: SafeTitle | undefined;
  readonly profile: RenderProfile;
  readonly representation: Representation;
  readonly names: ArtifactNames | undefined;
  readonly target: ArtifactTarget | undefined;
  readonly signal: AbortSignal | undefined;
}

const REQUEST_KEYS: ReadonlySet<string> = new Set([
  "source",
  "title",
  "profile",
  "render",
  "formats",
  "save",
  "cwd",
  "signal",
]);

export interface DiagramRendering {
  readonly profile: ProfileName;
  readonly display: DisplayRepresentation;
  /** The D2 source that was drawn, for the expanded view. */
  readonly source: D2Source;
  /** Why the text came out the way it did. Empty when nothing went wrong. */
  readonly diagnostics: readonly Diagnostic[];
  readonly image: StoredPng | undefined;
  readonly title: SafeTitle | undefined;
  readonly sourceHash: SourceHash;
  readonly lineCount: number;
  readonly widthCells: number;
  readonly d2Version: SupportedD2Version | undefined;
  readonly saved: readonly WrittenArtifact[];
  readonly notes: readonly string[];
}

/** Every request prepares Unicode, SVG, and PNG. */
export function parseRepresentation(requested: unknown): Representation {
  switch (requested) {
    case undefined:
    case "auto":
    case "image":
    case "unicode":
      return "unicode";
    case "source":
      return "source";
    default:
      throw new DiagramSourceError("Unsupported render mode.", [
        {
          code: "D2_SOURCE",
          message: `${describeInvalidValue(requested)} is not a render mode.`,
          hint: "Use auto, image, unicode, or source.",
        },
      ]);
  }
}

function parseSignal(raw: unknown): AbortSignal | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw instanceof AbortSignal) {
    return raw;
  }
  throw new DiagramSourceError("Diagram cancellation signal is not usable.", [
    { code: "D2_SOURCE", message: `Received ${describeInvalidValue(raw)}.` },
  ]);
}

/** Converts every host-facing field before D2 starts or a path is resolved. */
async function parseDiagramRequest(request: unknown): Promise<ParsedDiagramRequest> {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new DiagramSourceError("Diagram request must be an object.", [
      { code: "D2_SOURCE", message: `Received ${describeInvalidValue(request)}.` },
    ]);
  }
  const unexpected = Object.keys(request).find((key) => !REQUEST_KEYS.has(key));
  if (unexpected !== undefined) {
    throw new DiagramSourceError("Diagram request has an unsupported field.", [
      { code: "D2_SOURCE", message: `${describeInvalidValue(unexpected)} is not supported.` },
    ]);
  }
  const read = (key: string): unknown =>
    Object.hasOwn(request, key) ? Reflect.get(request, key) : undefined;

  const parsedSource = parseD2Source(read("source"));
  const { source } = parsedSource;
  const title = parseTitle(read("title"));
  const profile = parseProfile(read("profile"));
  const representation = parseRepresentation(read("render"));
  const save = read("save");
  const formats = read("formats");
  const names =
    save !== undefined || formats !== undefined
      ? parseArtifactNames({ formats, save }, { title, hash: parsedSource.hash })
      : undefined;
  const target = names === undefined ? undefined : await parseArtifactTarget(read("cwd"), names);
  return {
    parsedSource,
    source,
    title,
    profile,
    representation,
    names,
    target,
    signal: parseSignal(read("signal")),
  };
}

interface PreparedDiagram extends Omit<DiagramRendering, "saved"> {
  readonly contents: ReadonlyMap<ArtifactFormat, string | Uint8Array>;
}

export async function renderDiagram(
  request: unknown,
  renderer: D2Renderer,
  rasterizer: SvgRasterizer = new ResvgRasterizer(),
): Promise<DiagramRendering> {
  const parsed = await parseDiagramRequest(request);
  const { names, parsedSource, profile, representation, signal, source, target, title } = parsed;
  throwIfCancelled(signal, "Drawing the diagram");

  const notes: string[] = [];
  const savesSvg = names?.formats.includes("svg") === true;
  const savesPng = names?.formats.includes("png") === true;
  const drawn = await tryRender(renderer, source, signal);
  const textFailure = drawn instanceof TextRenderUnavailableError ? drawn : undefined;
  const text = drawn instanceof TextRenderUnavailableError ? undefined : drawn.text;

  let svg: D2Svg | undefined;
  try {
    svg = await renderer.renderSvg({ source, profile, signal });
  } catch (error) {
    if (!(error instanceof SvgRenderUnavailableError) || savesSvg || savesPng) {
      throw error;
    }
    notes.push(`${safeErrorMessage(error)} The SVG and PNG could not be generated.`);
  }

  const raster =
    svg === undefined ? undefined : await tryRasterize(rasterizer, svg.svg, signal, notes);

  const contents = new Map<ArtifactFormat, string | Uint8Array>();
  if (target !== undefined && names !== undefined) {
    if (names.formats.includes("source")) {
      contents.set("source", await sourceToSave(renderer, source, signal));
    }
    if (names.formats.includes("svg") && svg !== undefined) {
      contents.set("svg", `${svg.svg}\n`);
    }
    if (names.formats.includes("png")) {
      if (raster === undefined) {
        notes.push("No .png was written, because the PNG could not be generated.");
      } else {
        contents.set("png", raster.png);
      }
    }
    if (names.formats.includes("txt")) {
      if (text === undefined) {
        notes.push("No .txt was written, because D2 could not draw this diagram as text.");
      } else {
        contents.set("txt", `${text}\n`);
      }
    }
  }

  const image =
    raster === undefined
      ? undefined
      : await keepImage(raster, title, parsedSource.hash, notes, signal);
  const willWrite = target !== undefined && contents.size > 0;

  let prepared: PreparedDiagram;
  if (textFailure !== undefined && representation !== "source") {
    if (!willWrite && image === undefined) {
      throw explain(textFailure);
    }
    notes.push("The diagram is shown as source, because D2 could not draw it as text.");
    prepared = {
      title,
      profile: profile.name,
      sourceHash: parsedSource.hash,
      ...measure(source, MAX_COLUMNS),
      display: { kind: "source", content: source },
      source,
      diagnostics: textFailure.diagnostics,
      image,
      d2Version: svg?.version,
      notes,
      contents,
    };
  } else {
    const display: DisplayRepresentation =
      representation === "source" || text === undefined
        ? { kind: "source", content: source }
        : { kind: "unicode", content: text };
    prepared = {
      title,
      profile: profile.name,
      sourceHash: parsedSource.hash,
      ...measure(display.content, MAX_COLUMNS),
      display,
      source,
      diagnostics: [],
      image,
      d2Version:
        drawn === undefined || drawn instanceof TextRenderUnavailableError
          ? svg?.version
          : drawn.version,
      notes,
      contents,
    };
  }

  throwIfCancelled(signal, "Writing diagram artifacts");
  const saved = target === undefined ? [] : await writeArtifacts(target, prepared.contents, signal);
  const { contents: _contents, ...rendering } = prepared;
  return { ...rendering, saved };
}

/** Formats source for readable checked-in artifacts. */
async function sourceToSave(
  renderer: D2Renderer,
  source: D2Source,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfCancelled(signal, "Formatting the diagram source");
  let formatted: string;
  try {
    formatted = await renderer.formatSource({ source, signal });
  } catch (error) {
    if (error instanceof SourceFormatUnavailableError) {
      // Formatting changes presentation only. The source already passed the safe-subset parser.
      return `${source}\n`;
    }
    throw error;
  }
  try {
    // Formatter output is untrusted.
    return `${parseD2Source(formatted).source}\n`;
  } catch (error) {
    if (error instanceof DiagramSourceError) {
      return `${source}\n`;
    }
    throw error;
  }
}

/** PNG failure leaves text usable. */
async function tryRasterize(
  rasterizer: SvgRasterizer,
  svg: Parameters<SvgRasterizer["rasterize"]>[0]["svg"],
  signal: AbortSignal | undefined,
  notes: string[],
): Promise<RasterImage | undefined> {
  try {
    const raster = await rasterizer.rasterize({ svg, signal });
    if (raster.systemFonts) {
      notes.push(
        "Some labels use characters the diagram's own font does not carry, so the image was " +
          "drawn with the fonts installed on this machine.",
      );
    }
    return raster;
  } catch (error) {
    if (!(error instanceof ImageRenderUnavailableError)) {
      throw error;
    }
    notes.push(`${error.message} The PNG could not be generated.`);
    return undefined;
  }
}

/** The temp store keeps the bytes out of the model's context and out of the repository. */
async function keepImage(
  raster: RasterImage,
  title: SafeTitle | undefined,
  hash: SourceHash,
  notes: string[],
  signal: AbortSignal | undefined,
): Promise<StoredPng | undefined> {
  try {
    const names = parseArtifactNames({ formats: ["png"] }, { title, hash });
    const target = await parseArtifactTarget(undefined, names);
    const [written] = await writeArtifacts(target, new Map([["png", raster.png]]), signal);
    if (written === undefined) {
      return undefined;
    }
    return { path: written.path, widthPx: raster.widthPx, heightPx: raster.heightPx };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    notes.push(`The image could not be stored: ${safeErrorMessage(error)}`);
    return undefined;
  }
}

/** Preserves usable images and artifacts when text rendering fails. */
async function tryRender(
  renderer: D2Renderer,
  source: D2Source,
  signal: AbortSignal | undefined,
): Promise<D2Text | TextRenderUnavailableError> {
  try {
    return await renderer.renderText({ source, asciiMode: "extended", signal });
  } catch (error) {
    if (error instanceof TextRenderUnavailableError) {
      return error;
    }
    throw error;
  }
}

function explain(failure: TextRenderUnavailableError): TextRenderUnavailableError {
  return new TextRenderUnavailableError(
    `${failure.message} D2's text renderer is beta and cannot draw every diagram. ` +
      'Try a simpler diagram, or ask for `render: "source"` to see the D2 source instead.',
    failure.diagnostics,
  );
}
/** Returns the terminal cells consumed by one line without allocating a grapheme array. */
function lineWidthCells(line: string): number {
  let width = 0;
  for (const character of line) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (/\p{Mark}|\p{Cf}/u.test(character)) {
      continue;
    }
    width +=
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x1100 && codePoint <= 0x115f) ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
        ? 2
        : 1;
  }
  return width;
}

/** Throws if the drawing is too big to belong in a transcript. */
function measure(text: string, maxColumns: number): { lineCount: number; widthCells: number } {
  const lines = text.split("\n");
  let widthCells = 0;
  for (const line of lines) {
    widthCells = Math.max(widthCells, lineWidthCells(line));
  }

  const bytes = Buffer.byteLength(text, "utf8");
  if (lines.length > MAX_LINES || widthCells > maxColumns || bytes > MAX_BYTES) {
    throw new DiagramSourceError("The rendered diagram is too big for the transcript.", [
      {
        code: "D2_TOO_LARGE",
        message: `It is ${lines.length} lines by ${widthCells} columns (${bytes} bytes); the limit is ${MAX_LINES} by ${maxColumns} (${MAX_BYTES} bytes).`,
        hint: "Show fewer nodes, shorten labels, or split it into several diagrams.",
      },
    ]);
  }
  return { lineCount: lines.length, widthCells };
}
