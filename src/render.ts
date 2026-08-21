import {
  type ArtifactFormat,
  parseArtifactNames,
  parseArtifactTarget,
  type WrittenArtifact,
  writeArtifacts,
} from "./artifacts.js";
import { type Diagnostic, DiagramSourceError } from "./d2/diagnostics.js";
import { parseSafeSource, type SafeD2Source } from "./d2/preflight.js";
import { type ProfileName, parseProfile } from "./d2/profiles.js";
import {
  type AsciiMode,
  type D2Renderer,
  type SupportedD2Version,
  TextRenderUnavailableError,
} from "./d2/runner.js";
import { normalizeSource, parseTitle, type SafeTitle } from "./normalize.js";
import {
  ImageRenderUnavailableError,
  type RasterImage,
  ResvgRasterizer,
  type SvgRasterizer,
} from "./raster.js";

/**
 * D2's text renderer is beta, so a diagram it cannot draw has to fail in a way the user can
 * understand rather than turning into broken box art or a different graph.
 */

/** How the diagram is drawn as text. */
export type Representation = "unicode" | "ascii" | "source";

/** Bounds for one transcript diagram. */
const MAX_LINES = 300;
const MAX_COLUMNS = 400;
const MAX_BYTES = 32 * 1024;

export interface DiagramRequest {
  readonly source: unknown;
  readonly title?: unknown;
  readonly profile?: unknown;
  readonly render?: unknown;
  readonly formats?: unknown;
  readonly save?: unknown;
  readonly cwd?: unknown;
  /** Whether the host can display an image at all. Only `true` enables the raster path. */
  readonly images?: unknown;
  readonly signal?: AbortSignal | undefined;
}

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
  readonly sourceHash: string;
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
    case "ascii":
      return "ascii";
    case "source":
      return "source";
    default:
      throw new DiagramSourceError("Unsupported render mode.", [
        {
          code: "D2_SOURCE",
          message: `${JSON.stringify(requested)} is not a render mode.`,
          hint: "Use auto, image, unicode, ascii, or source.",
        },
      ]);
  }
}

/** Asking for a text representation suppresses the image, rather than producing both. */
function wantsImage(request: DiagramRequest): boolean {
  if (request.images !== true) {
    return false;
  }
  return request.render === undefined || request.render === "auto" || request.render === "image";
}

export async function renderDiagram(
  request: DiagramRequest,
  renderer: D2Renderer,
  rasterizer: SvgRasterizer = new ResvgRasterizer(),
): Promise<DiagramRendering> {
  const normalized = normalizeSource(request.source);
  const source = parseSafeSource(normalized.text);
  const representation = parseRepresentation(request.render);
  const profile = parseProfile(request.profile);
  const title = parseTitle(request.title);
  // Everything the request asks for is parsed before D2 starts, so a bad save path costs nothing.
  const wantsFiles = request.save !== undefined || request.formats !== undefined;
  const names = wantsFiles
    ? parseArtifactNames(
        { formats: request.formats, save: request.save },
        { title, hash: normalized.hash },
      )
    : undefined;
  const target = names === undefined ? undefined : await parseArtifactTarget(request.cwd, names);

  const notes: string[] = [];
  const showsImage = wantsImage(request);
  const savesPng = names?.formats.includes("png") === true;
  const wantsText = representation !== "source" || names?.formats.includes("txt") === true;
  let mode: AsciiMode = representation === "ascii" ? "standard" : "extended";
  let drawn = wantsText ? await tryRender(renderer, source, mode, request.signal) : undefined;

  if (drawn instanceof TextRenderUnavailableError && mode === "extended") {
    // Exactly one fallback attempt, so a beta renderer cannot be retried indefinitely.
    const retry = await tryRender(renderer, source, "standard", request.signal);
    if (!(retry instanceof TextRenderUnavailableError)) {
      notes.push("Unicode output failed, so this diagram is drawn in plain ASCII.");
      mode = "standard";
      drawn = retry;
    }
  }

  const textFailure = drawn instanceof TextRenderUnavailableError ? drawn : undefined;
  const text = drawn instanceof TextRenderUnavailableError ? undefined : drawn?.text;

  const svg =
    names?.formats.includes("svg") === true || showsImage || savesPng
      ? await renderer.renderSvg({ source, profile, signal: request.signal })
      : undefined;

  let raster: RasterImage | undefined;
  if (svg !== undefined && (showsImage || savesPng)) {
    raster = await tryRasterize(rasterizer, svg.svg, request.signal, notes);
  }

  let saved: readonly WrittenArtifact[] = [];
  if (target !== undefined && names !== undefined) {
    // Every text artifact ends with a newline, the way any other checked-in text file does.
    const contents = new Map<ArtifactFormat, string | Uint8Array>([
      ["source", await sourceToSave(renderer, source, request.signal)],
    ]);
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
    saved = await writeArtifacts(target, contents);
  }

  const image =
    raster === undefined || !showsImage
      ? undefined
      : await keepImage(raster, title, normalized.hash, notes);

  // Work that came out fine is not discarded because the text renderer choked.
  if (textFailure !== undefined && representation !== "source") {
    if (saved.length === 0 && image === undefined) {
      throw explain(textFailure);
    }
    notes.push("The diagram is shown as source, because D2 could not draw it as text.");
    return {
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
      saved,
      notes,
    };
  }

  // Text may have been drawn only to write a .txt sidecar, which must not override the
  // representation the caller asked for.
  const showSource = representation === "source" || text === undefined;
  return {
    title,
    profile: profile.name,
    sourceHash: normalized.hash,
    ...measure(showSource ? source : (text as string), MAX_COLUMNS),
    renderedAs: showSource ? "source" : mode === "standard" ? "ascii" : "unicode",
    text: showSource ? source : (text as string),
    source,
    diagnostics: [],
    image,
    d2Version:
      drawn instanceof TextRenderUnavailableError ? svg?.version : (drawn?.version ?? svg?.version),
    saved,
    notes,
  };
}

/** A checked-in `.d2` is read and edited by people later, so it is saved formatted. */
async function sourceToSave(
  renderer: D2Renderer,
  source: SafeD2Source,
  signal: AbortSignal | undefined,
): Promise<string> {
  try {
    const formatted = await renderer.formatSource({ source, signal });
    // Parsed again, because nothing reaches the workspace without passing the safe subset.
    return `${parseSafeSource(normalizeSource(formatted).text)}\n`;
  } catch {
    // Formatting is cosmetic, so what the model wrote is saved as it is.
    return `${source}\n`;
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
  hash: string,
  notes: string[],
): Promise<DiagramImage | undefined> {
  try {
    const names = parseArtifactNames({ formats: ["png"] }, { title, hash });
    const target = await parseArtifactTarget(undefined, names);
    const [written] = await writeArtifacts(target, new Map([["png", raster.png]]));
    if (written === undefined) {
      return undefined;
    }
    return { path: written.path, widthPx: raster.widthPx, heightPx: raster.heightPx };
  } catch (error) {
    notes.push(`The image could not be stored: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Returns a text-renderer failure as a value so the caller can decide whether to retry.
 * Everything else, including source errors and cancellation, still throws.
 */
async function tryRender(
  renderer: D2Renderer,
  source: SafeD2Source,
  asciiMode: AsciiMode,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<D2Renderer["renderText"]>> | TextRenderUnavailableError> {
  try {
    return await renderer.renderText({ source, asciiMode, signal });
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

/** Throws if the drawing is too big to belong in a transcript. */
function measure(text: string, maxColumns: number): { lineCount: number; widthCells: number } {
  const lines = text.split("\n");
  let widthCells = 0;
  for (const line of lines) {
    widthCells = Math.max(widthCells, Array.from(line).length);
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
