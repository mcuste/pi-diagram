import type { NormalizedD2Source } from "../normalize.js";
import { type Diagnostic, DiagramSourceError } from "./diagnostics.js";

/**
 * The safe D2 subset. `@` imports read files, `icon` loads local paths and remote URLs, and
 * source can override the layout engine. A relative import was verified against d2 0.8.1 to
 * read a sibling file and draw its contents, so this is a live file-read channel.
 *
 * Anything ambiguous is refused rather than guessed at. See docs/safety.md for the full policy.
 */

declare const safeSourceBrand: unique symbol;

/** The renderer accepts nothing else, so unchecked source cannot reach D2. */
export type SafeD2Source = NormalizedD2Source & { readonly [safeSourceBrand]: true };

/** D2's documented shapes, less `image`, which loads a file or a URL. */
const ALLOWED_SHAPES: ReadonlySet<string> = new Set([
  "rectangle",
  "square",
  "page",
  "parallelogram",
  "document",
  "cylinder",
  "queue",
  "package",
  "step",
  "callout",
  "stored_data",
  "person",
  "diamond",
  "oval",
  "circle",
  "hexagon",
  "cloud",
  "text",
  "code",
  "class",
  "sql_table",
  "sequence_diagram",
  "c4-person",
]);

/** D2 treats `user@example.com` as label text, so only a token-initial `@` is an import. */
const IMPORT = /(?:^|[\s:{};,])@|\.\.\.[ \t]*@/gu;
const ASSET_KEY = /(?:^|[\s{};,.])(icon|link)[ \t]*:/gu;
const SHAPE_KEY = /(?:^|[\s{};,.])shape[ \t]*:[ \t]*(\S*)/gu;
const CONFIG_KEY = /(?:^|[\s{};,.])(d2-config|layout-engine)[ \t]*:/gu;

interface Located {
  readonly line: number;
  readonly column: number;
}

/** Throws with one diagnostic per problem found, rather than at the first. */
export function parseSafeSource(source: NormalizedD2Source): SafeD2Source {
  const diagnostics = inspect(source);
  if (diagnostics.length > 0) {
    throw new DiagramSourceError(
      "Diagram source uses D2 features this tool does not allow.",
      diagnostics,
    );
  }
  return source as SafeD2Source;
}

/** Exported so tests can read the diagnostics without catching the error. */
export function inspect(source: NormalizedD2Source): readonly Diagnostic[] {
  const lineStarts = buildLineStarts(source);
  const locate = (offset: number): Located => locateOffset(lineStarts, offset);
  const { masked, diagnostics } = mask(source, locate);
  if (diagnostics.length > 0) {
    // Masking stopped early, so the rest of the source cannot be read reliably.
    return diagnostics;
  }
  return scan(masked, locate);
}

/**
 * Blanks the inside of comments and quoted strings, keeping delimiters and every offset so
 * diagnostics can carry a real line and column. Stops at a block string, where code and content
 * can no longer be told apart, and at an unterminated string, which D2 also rejects.
 */
function mask(
  source: string,
  locate: (offset: number) => Located,
): { masked: string; diagnostics: readonly Diagnostic[] } {
  const out: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] as string;

    if (char === "#") {
      out.push("#");
      index += 1;
      while (index < source.length && source[index] !== "\n") {
        out.push(" ");
        index += 1;
      }
      continue;
    }

    if (char === "|") {
      return {
        masked: out.join(""),
        diagnostics: [
          {
            code: "D2_BLOCK_STRING",
            message: "Block strings and Markdown, LaTeX, or code labels are not allowed.",
            hint: "Use a plain quoted label. They also render as an empty box in text output.",
            ...locate(index),
          },
        ],
      };
    }

    if (char === '"' || char === "'") {
      const closed = maskString(source, index, char, out);
      if (closed === undefined) {
        return {
          masked: out.join(""),
          diagnostics: [
            {
              code: "D2_UNTERMINATED",
              message: `Unterminated ${char === '"' ? "double" : "single"}-quoted string.`,
              hint: "Close the quote. D2 rejects strings that span lines.",
              ...locate(index),
            },
          ],
        };
      }
      index = closed;
      continue;
    }

    out.push(char);
    index += 1;
  }

  return { masked: out.join(""), diagnostics: [] };
}

/**
 * Returns the offset past the closing quote, or `undefined` if it never closes on its line.
 * Double quotes honour backslash escapes; single quotes are raw.
 */
function maskString(
  source: string,
  start: number,
  quote: string,
  out: string[],
): number | undefined {
  out.push(quote);
  let index = start + 1;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "\n") {
      return undefined;
    }
    if (quote === '"' && char === "\\" && index + 1 < source.length) {
      out.push(" ", " ");
      index += 2;
      continue;
    }
    if (char === quote) {
      out.push(quote);
      return index + 1;
    }
    out.push(" ");
    index += 1;
  }
  return undefined;
}

function scan(masked: string, locate: (offset: number) => Located): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const match of masked.matchAll(IMPORT)) {
    const offset = match.index + match[0].indexOf("@");
    diagnostics.push({
      code: "D2_IMPORT",
      message: "Imports are not allowed. They can read any file on this machine.",
      hint: "Write the whole diagram in this call, and quote the label if you meant text.",
      ...locate(offset),
    });
  }

  for (const match of masked.matchAll(ASSET_KEY)) {
    const key = match[1] as string;
    diagnostics.push(
      key === "icon"
        ? {
            code: "D2_ICON",
            message: "Icons are not allowed. They load local files or remote URLs.",
            hint: "Use a built-in shape and a label instead.",
            ...locate(match.index + match[0].indexOf(key)),
          }
        : {
            code: "D2_LINK",
            message: "Links are not allowed.",
            hint: "Put the destination in the label text if it matters.",
            ...locate(match.index + match[0].indexOf(key)),
          },
    );
  }

  for (const match of masked.matchAll(SHAPE_KEY)) {
    const value = (match[1] ?? "").replace(/[{};,]+$/u, "");
    if (ALLOWED_SHAPES.has(value)) {
      continue;
    }
    const offset = match.index + match[0].indexOf("shape");
    diagnostics.push(
      value === "image"
        ? {
            code: "D2_IMAGE_SHAPE",
            message: "`shape: image` is not allowed. It loads a local file or a remote URL.",
            hint: "Use a built-in shape such as `rectangle` or `cylinder`.",
            ...locate(offset),
          }
        : {
            code: "D2_UNKNOWN_SHAPE",
            message: `Unsupported shape ${JSON.stringify(value)}.`,
            hint: `Allowed shapes: ${[...ALLOWED_SHAPES].join(", ")}.`,
            ...locate(offset),
          },
    );
  }

  for (const match of masked.matchAll(CONFIG_KEY)) {
    const key = match[1] as string;
    diagnostics.push({
      code: "D2_CONFIG",
      message: `Renderer configuration (${key}) cannot be set from diagram source.`,
      hint: "Layout and theme are chosen by this tool.",
      ...locate(match.index + match[0].indexOf(key)),
    });
  }

  return diagnostics.sort(byPosition);
}

function byPosition(left: Diagnostic, right: Diagnostic): number {
  return (left.line ?? 0) - (right.line ?? 0) || (left.column ?? 0) - (right.column ?? 0);
}

function buildLineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function locateOffset(lineStarts: readonly number[], offset: number): Located {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] as number) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { line: low + 1, column: offset - (lineStarts[low] as number) + 1 };
}
