import type { Diagnostic, DiagnosticCode } from "@mcuste/pi-diagram-core";

/** A refusal reason, less the source position the scanner supplies. */
interface Refusal {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly hint: string;
}

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
    switch (character) {
      case "#":
        index = skipComment(source, index + 1);
        continue;
      case "|":
        return [{ ...BLOCK_STRING, ...locate(index) }];
      case '"':
      case "'": {
        const end = skipString(source, index, character);
        if (end === undefined) {
          return [{ ...unterminatedString(character), ...locate(index) }];
        }
        index = end;
        continue;
      }
      case "@":
        if (!isIdentifierPart(source[index - 1] ?? "")) {
          diagnostics.push({ ...IMPORT, ...locate(index) });
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
    const rule = KEY_RULES.get(key);
    if (!rule) {
      continue;
    }
    const refusal = rule(readValue(source, skipHorizontalSpace(source, colon + 1)));
    if (refusal) {
      diagnostics.push({ ...refusal, ...locate(keyStart) });
    }
  }
  return diagnostics;
}

const BLOCK_STRING: Refusal = {
  code: "D2_BLOCK_STRING",
  message: "Block strings and Markdown, LaTeX, or code labels are not allowed.",
  hint: "Use a plain quoted label. They also render as an empty box in text output.",
};

function unterminatedString(quote: string): Refusal {
  return {
    code: "D2_UNTERMINATED",
    message: `Unterminated ${quote === '"' ? "double" : "single"}-quoted string.`,
    hint: "Close the quote. D2 rejects strings that span lines.",
  };
}

const IMPORT: Refusal = {
  code: "D2_IMPORT",
  message: "Imports are not allowed. They can read any file on this machine.",
  hint: "Write the whole diagram in this call, and quote the label if you meant text.",
};

/** Decides a key's fate from the text after the colon. Keys with no rule pass through. */
type KeyRule = (value: string) => Refusal | undefined;

const KEY_RULES: ReadonlyMap<string, KeyRule> = new Map<string, KeyRule>([
  ["icon", () => ICON],
  ["link", () => LINK],
  ["d2-config", () => configRefusal("d2-config")],
  ["layout-engine", () => configRefusal("layout-engine")],
  ["shape", shapeRefusal],
]);

const ICON: Refusal = {
  code: "D2_ICON",
  message: "Icons are not allowed. They load local files or remote URLs.",
  hint: "Use a built-in shape and a label instead.",
};

const LINK: Refusal = {
  code: "D2_LINK",
  message: "Links are not allowed.",
  hint: "Put the destination in the label text if it matters.",
};

function configRefusal(key: string): Refusal {
  return {
    code: "D2_CONFIG",
    message: `Renderer configuration (${key}) cannot be set from diagram source.`,
    hint: "Layout and theme are chosen by this tool.",
  };
}

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

function shapeRefusal(value: string): Refusal | undefined {
  // D2 ignores case in shape names.
  const name = value.toLowerCase();
  if (ALLOWED_SHAPES.has(name)) {
    return undefined;
  }
  return name === "image" ? IMAGE_SHAPE : unknownShape(value);
}

const IMAGE_SHAPE: Refusal = {
  code: "D2_IMAGE_SHAPE",
  message: "`shape: image` is not allowed. It loads a local file or a remote URL.",
  hint: "Use a built-in shape such as `rectangle` or `cylinder`.",
};

function unknownShape(value: string): Refusal {
  return {
    code: "D2_UNKNOWN_SHAPE",
    message: `Unsupported shape ${JSON.stringify(value)}.`,
    hint: `Allowed shapes: ${[...ALLOWED_SHAPES].join(", ")}.`,
  };
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

/** The value text after `key:`, up to the first space or D2 separator. */
function readValue(source: string, start: number): string {
  let end = start;
  while (end < source.length && !/[\s{};,]/u.test(source[end] as string)) {
    end += 1;
  }
  return source.slice(start, end);
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
