import {
  type ArtifactFormat,
  parseArtifactNames,
  parseArtifactTarget,
  type WrittenArtifact,
  writeArtifacts,
} from "./artifacts.js";
import { DiagramSourceError } from "./d2/diagnostics.js";
import { parseSafeSource, type SafeD2Source } from "./d2/preflight.js";
import {
  type AsciiMode,
  type D2Renderer,
  type SupportedD2Version,
  TextRenderUnavailableError,
} from "./d2/runner.js";
import { normalizeSource, parseTitle, type SafeTitle } from "./normalize.js";

/**
 * D2's text renderer is beta, so a diagram it cannot draw has to fail in a way the user can
 * understand rather than turning into broken box art or a different graph.
 */

/** What a text-only transcript can show. Images arrive with the harness adapters. */
export type Representation = "unicode" | "ascii" | "source";

/** Bounds for one transcript diagram, from the complexity budgets in the design proposal. */
const MAX_LINES = 300;
const MAX_COLUMNS = 400;
const MAX_BYTES = 32 * 1024;

export interface DiagramRequest {
  readonly source: unknown;
  readonly title?: unknown;
  readonly render?: unknown;
  readonly formats?: unknown;
  readonly save?: unknown;
  readonly cwd?: unknown;
  readonly signal?: AbortSignal | undefined;
}

export interface DiagramRendering {
  readonly renderedAs: Representation;
  readonly text: string;
  readonly title: SafeTitle | undefined;
  readonly sourceHash: string;
  readonly lineCount: number;
  readonly widthCells: number;
  readonly d2Version: SupportedD2Version | undefined;
  readonly saved: readonly WrittenArtifact[];
  readonly notes: readonly string[];
}

/**
 * `image` is accepted and answered with text: an unavailable image is a display fallback, not
 * an error the model should try to correct.
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

export async function renderDiagram(
  request: DiagramRequest,
  renderer: D2Renderer,
): Promise<DiagramRendering> {
  const normalized = normalizeSource(request.source);
  const source = parseSafeSource(normalized.text);
  const representation = parseRepresentation(request.render);
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
  const wantsText = representation !== "source" || names?.formats.includes("txt") === true;
  let mode: AsciiMode = representation === "ascii" ? "standard" : "extended";
  let drawn = wantsText ? await tryRender(renderer, source, mode, request.signal) : undefined;

  if (drawn instanceof TextRenderUnavailableError && mode === "extended") {
    // The design proposal allows exactly one fallback attempt before giving up.
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
    names?.formats.includes("svg") === true
      ? await renderer.renderSvg({ source, signal: request.signal })
      : undefined;

  let saved: readonly WrittenArtifact[] = [];
  if (target !== undefined && names !== undefined) {
    // Every artifact ends with a newline, the way any other checked-in text file does.
    const contents = new Map<ArtifactFormat, string>([["source", `${source}\n`]]);
    if (svg !== undefined) {
      contents.set("svg", `${svg.svg}\n`);
    }
    if (text !== undefined) {
      contents.set("txt", `${text}\n`);
    } else if (names.formats.includes("txt")) {
      notes.push("No .txt was written, because D2 could not draw this diagram as text.");
    }
    saved = await writeArtifacts(target, contents);
  }

  // A beta text renderer must not discard an SVG that came out fine, so a saved diagram falls
  // back to showing its source rather than failing the whole call.
  if (textFailure !== undefined && representation !== "source") {
    if (saved.length === 0) {
      throw explain(textFailure);
    }
    notes.push("The diagram is shown as source, because D2 could not draw it as text.");
    return {
      title,
      sourceHash: normalized.hash,
      ...measure(source, MAX_COLUMNS),
      renderedAs: "source",
      text: source,
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
    sourceHash: normalized.hash,
    ...measure(showSource ? source : (text as string), MAX_COLUMNS),
    renderedAs: showSource ? "source" : mode === "standard" ? "ascii" : "unicode",
    text: showSource ? source : (text as string),
    d2Version:
      drawn instanceof TextRenderUnavailableError ? svg?.version : (drawn?.version ?? svg?.version),
    saved,
    notes,
  };
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
