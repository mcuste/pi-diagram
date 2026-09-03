import type { Diagnostic } from "@mcuste/pi-diagram-core";

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

interface Located {
  readonly line: number;
  readonly column: number;
}

/**
 * Lexes only the D2 constructs that can escape the sandbox. Strings and comments are consumed as
 * tokens, so keywords in labels never become policy decisions.
 */
export function inspect(source: string): readonly Diagnostic[] {
  const lineStarts = buildLineStarts(source);
  const locate = (offset: number): Located => locateOffset(lineStarts, offset);
  const diagnostics: Diagnostic[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index] as string;
    if (character === "#") {
      index = skipComment(source, index + 1);
      continue;
    }
    if (character === "|") {
      return [
        {
          code: "D2_BLOCK_STRING",
          message: "Block strings and Markdown, LaTeX, or code labels are not allowed.",
          hint: "Use a plain quoted label. They also render as an empty box in text output.",
          ...locate(index),
        },
      ];
    }
    if (character === '"' || character === "'") {
      const end = skipString(source, index, character);
      if (end === undefined) {
        return [
          {
            code: "D2_UNTERMINATED",
            message: `Unterminated ${character === '"' ? "double" : "single"}-quoted string.`,
            hint: "Close the quote. D2 rejects strings that span lines.",
            ...locate(index),
          },
        ];
      }
      index = end;
      continue;
    }
    if (character === "@") {
      if (!isIdentifierPart(source[index - 1] ?? "")) {
        diagnostics.push({
          code: "D2_IMPORT",
          message: "Imports are not allowed. They can read any file on this machine.",
          hint: "Write the whole diagram in this call, and quote the label if you meant text.",
          ...locate(index),
        });
      }
      index += 1;
      continue;
    }
    if (!isIdentifierStart(character)) {
      index += 1;
      continue;
    }

    const keyStart = index;
    index = skipIdentifier(source, index + 1);
    const key = source.slice(keyStart, index);
    const colon = skipHorizontalSpace(source, index);
    if (source[colon] !== ":") {
      continue;
    }
    const valueStart = skipHorizontalSpace(source, colon + 1);
    if (key === "icon" || key === "link") {
      diagnostics.push(assetDiagnostic(key, locate(keyStart)));
      continue;
    }
    if (key === "d2-config" || key === "layout-engine") {
      diagnostics.push({
        code: "D2_CONFIG",
        message: `Renderer configuration (${key}) cannot be set from diagram source.`,
        hint: "Layout and theme are chosen by this tool.",
        ...locate(keyStart),
      });
      continue;
    }
    if (key === "shape") {
      diagnostics.push(...shapeDiagnostics(source, valueStart, locate(keyStart)));
    }
  }
  return diagnostics;
}

function assetDiagnostic(key: "icon" | "link", location: Located): Diagnostic {
  return key === "icon"
    ? {
        code: "D2_ICON",
        message: "Icons are not allowed. They load local files or remote URLs.",
        hint: "Use a built-in shape and a label instead.",
        ...location,
      }
    : {
        code: "D2_LINK",
        message: "Links are not allowed.",
        hint: "Put the destination in the label text if it matters.",
        ...location,
      };
}

function shapeDiagnostics(source: string, start: number, location: Located): readonly Diagnostic[] {
  const end = skipShapeValue(source, start);
  const value = source.slice(start, end).replace(/[{};,]+$/u, "");
  if (ALLOWED_SHAPES.has(value)) {
    return [];
  }
  return [
    value === "image"
      ? {
          code: "D2_IMAGE_SHAPE",
          message: "`shape: image` is not allowed. It loads a local file or a remote URL.",
          hint: "Use a built-in shape such as `rectangle` or `cylinder`.",
          ...location,
        }
      : {
          code: "D2_UNKNOWN_SHAPE",
          message: `Unsupported shape ${JSON.stringify(value)}.`,
          hint: `Allowed shapes: ${[...ALLOWED_SHAPES].join(", ")}.`,
          ...location,
        },
  ];
}

function skipComment(source: string, index: number): number {
  while (index < source.length && source[index] !== "\n") {
    index += 1;
  }
  return index;
}

function skipString(source: string, start: number, quote: string): number | undefined {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index] as string;
    if (character === "\n") {
      return undefined;
    }
    if (quote === '"' && character === "\\") {
      if (source[index + 1] === undefined || source[index + 1] === "\n") {
        return undefined;
      }
      index += 2;
      continue;
    }
    if (character === quote) {
      return index + 1;
    }
    index += 1;
  }
  return undefined;
}

function skipShapeValue(source: string, index: number): number {
  while (index < source.length && !/[\s{};,]/u.test(source[index] as string)) {
    index += 1;
  }
  return index;
}

function skipHorizontalSpace(source: string, index: number): number {
  while (source[index] === " " || source[index] === "\t") {
    index += 1;
  }
  return index;
}

function skipIdentifier(source: string, index: number): number {
  while (isIdentifierPart(source[index] ?? "")) {
    index += 1;
  }
  return index;
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/u.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_-]/u.test(character);
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
