import {
  type ArtifactFormat,
  type ArtifactNames,
  type ArtifactTarget,
  parseArtifactNames,
  parseArtifactTarget,
  type WrittenArtifact,
  writeArtifacts,
} from "./artifacts.js";
import { type Diagnostic, DiagramSourceError } from "./d2/diagnostics.js";
import { parseSafeSource, type SafeD2Source } from "./d2/preflight.js";
import { type ProfileName, parseProfile, type RenderProfile } from "./d2/profiles.js";
import {
  type D2Renderer,
  type D2Text,
  SourceFormatUnavailableError,
  type SupportedD2Version,
  SvgRenderUnavailableError,
  TextRenderUnavailableError,
} from "./d2/runner.js";
import {
  type NormalizedSource,
  normalizeSource,
  parseTitle,
  type SafeTitle,
  type SourceHash,
} from "./normalize.js";
import { throwIfCancelled } from "./process.js";
import {
  ImageRenderUnavailableError,
  type RasterImage,
  ResvgRasterizer,
  type SvgRasterizer,
} from "./raster.js";
import { describeUnknown, errorMessage } from "./unknown.js";

/** D2's beta text renderer must fail rather than substitute another drawing. */
export type Representation = "unicode" | "source";

const MAX_LINES = 300;
const MAX_COLUMNS = 400;
const MAX_BYTES = 32 * 1024;

interface ParsedDiagramRequest {
  readonly normalized: NormalizedSource;
  readonly source: SafeD2Source;
  readonly title: SafeTitle | undefined;
  readonly profile: RenderProfile;
  readonly representation: Representation;
  readonly showImage: boolean;
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
  "images",
  "signal",
]);

interface DiagramImage {
  /** Absolute path in the temp store. */
  readonly path: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface DiagramRendering {
  readonly profile: ProfileName;
  readonly renderedAs: Representation;
  readonly text: string;
  /** The D2 source that was drawn, for the expanded view. */
  readonly source: string;
  /** Why the text came out the way it did. Empty when nothing went wrong. */
  readonly diagnostics: readonly Diagnostic[];
  readonly image: DiagramImage | undefined;
  readonly title: SafeTitle | undefined;
  readonly sourceHash: SourceHash;
  readonly lineCount: number;
  readonly widthCells: number;
  readonly d2Version: SupportedD2Version | undefined;
  readonly saved: readonly WrittenArtifact[];
  readonly notes: readonly string[];
}

/**
 * `image` and `auto` choose the text that goes with the image. Whether a terminal can show one is
 * only decided when the result is displayed, so both are always prepared.
 */
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
          message: `${describeUnknown(requested)} is not a render mode.`,
          hint: "Use auto, image, unicode, or source.",
        },
      ]);
  }
}

function parseImages(raw: unknown): boolean {
  if (raw === undefined) {
    return false;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  throw new DiagramSourceError("Diagram image setting must be a boolean.", [
    { code: "D2_SOURCE", message: `Received ${describeUnknown(raw)}.` },
  ]);
}

function parseSignal(raw: unknown): AbortSignal | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw instanceof AbortSignal) {
    return raw;
  }
  throw new DiagramSourceError("Diagram cancellation signal is not usable.", [
    { code: "D2_SOURCE", message: `Received ${describeUnknown(raw)}.` },
  ]);
}

/** Converts every host-facing field before D2 starts or a path is resolved. */
async function parseDiagramRequest(request: unknown): Promise<ParsedDiagramRequest> {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new DiagramSourceError("Diagram request must be an object.", [
      { code: "D2_SOURCE", message: `Received ${describeUnknown(request)}.` },
    ]);
  }
  const unexpected = Object.keys(request).find((key) => !REQUEST_KEYS.has(key));
  if (unexpected !== undefined) {
    throw new DiagramSourceError("Diagram request has an unsupported field.", [
      { code: "D2_SOURCE", message: `${describeUnknown(unexpected)} is not supported.` },
    ]);
  }
  const read = (key: string): unknown =>
    Object.hasOwn(request, key) ? Reflect.get(request, key) : undefined;

  const normalized = normalizeSource(read("source"));
  const source = parseSafeSource(normalized.text);
  const title = parseTitle(read("title"));
  const profile = parseProfile(read("profile"));
  const requestedRender = read("render");
  const representation = parseRepresentation(requestedRender);
  const save = read("save");
  const formats = read("formats");
  const names =
    save !== undefined || formats !== undefined
      ? parseArtifactNames({ formats, save }, { title, hash: normalized.hash })
      : undefined;
  const target = names === undefined ? undefined : await parseArtifactTarget(read("cwd"), names);
  const images = parseImages(read("images"));
  return {
    normalized,
    source,
    title,
    profile,
    representation,
    showImage:
      images &&
      (requestedRender === undefined || requestedRender === "auto" || requestedRender === "image"),
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
  const { names, normalized, profile, representation, showImage, signal, source, target, title } =
    parsed;
  throwIfCancelled(signal, "Drawing the diagram");

  const notes: string[] = [];
  const savesPng = names?.formats.includes("png") === true;
  const wantsText = representation !== "source" || names?.formats.includes("txt") === true;
  const drawn = wantsText ? await tryRender(renderer, source, signal) : undefined;
  const textFailure = drawn instanceof TextRenderUnavailableError ? drawn : undefined;
  const text =
    drawn === undefined || drawn instanceof TextRenderUnavailableError ? undefined : drawn.text;

  const needsSvg = names?.formats.includes("svg") === true || savesPng;
  let svg: Awaited<ReturnType<D2Renderer["renderSvg"]>> | undefined;
  if (needsSvg || showImage) {
    try {
      svg = await renderer.renderSvg({ source, profile, signal });
    } catch (error) {
      if (!(error instanceof SvgRenderUnavailableError) || needsSvg) {
        throw error;
      }
      notes.push(`${errorMessage(error)} The diagram is shown as text instead.`);
    }
  }

  const raster =
    svg === undefined || (!showImage && !savesPng)
      ? undefined
      : await tryRasterize(rasterizer, svg.svg, signal, notes);

  const contents = new Map<ArtifactFormat, string | Uint8Array>();
  if (target !== undefined && names !== undefined) {
    contents.set("source", await sourceToSave(renderer, source, signal));
    if (svg !== undefined) {
      contents.set("svg", `${svg.svg}\n`);
    }
    if (raster !== undefined) {
      contents.set("png", raster.png);
    } else if (savesPng) {
      notes.push("No .png was written, because the diagram could not be drawn as an image.");
    }
    if (text !== undefined) {
      contents.set("txt", `${text}\n`);
    } else if (names.formats.includes("txt")) {
      notes.push("No .txt was written, because D2 could not draw this diagram as text.");
    }
  }

  const image =
    raster === undefined || !showImage
      ? undefined
      : await keepImage(raster, title, normalized.hash, notes, signal);
  const willWrite =
    names !== undefined && [...names.formats].some((format) => contents.has(format));

  let prepared: PreparedDiagram;
  if (textFailure !== undefined && representation !== "source") {
    if (!willWrite && image === undefined) {
      throw explain(textFailure);
    }
    notes.push("The diagram is shown as source, because D2 could not draw it as text.");
    prepared = {
      title,
      profile: profile.name,
      sourceHash: normalized.hash,
      ...measure(source, MAX_COLUMNS),
      renderedAs: "source",
      text: source,
      source,
      diagnostics: textFailure.diagnostics,
      image,
      d2Version: svg?.version,
      notes,
      contents,
    };
  } else {
    // Text may have been drawn only to write a .txt sidecar, which must not override the request.
    const displayText = representation === "source" || text === undefined ? source : text;
    prepared = {
      title,
      profile: profile.name,
      sourceHash: normalized.hash,
      ...measure(displayText, MAX_COLUMNS),
      renderedAs: representation === "source" || text === undefined ? "source" : "unicode",
      text: displayText,
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
  source: SafeD2Source,
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
    return `${parseSafeSource(normalizeSource(formatted).text)}\n`;
  } catch (error) {
    if (error instanceof DiagramSourceError) {
      return `${source}\n`;
    }
    throw error;
  }
}

/** An image that cannot be drawn is a display fallback, not a failure the model should correct. */
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
    notes.push(`${error.message} The diagram is shown as text instead.`);
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
): Promise<DiagramImage | undefined> {
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
    notes.push(`The image could not be stored: ${errorMessage(error)}`);
    return undefined;
  }
}

/** Preserves usable images and artifacts when text rendering fails. */
async function tryRender(
  renderer: D2Renderer,
  source: SafeD2Source,
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
