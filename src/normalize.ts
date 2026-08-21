import { createHash } from "node:crypto";
import { DiagramSourceError } from "./d2/diagnostics.js";

/** Byte-level enforcement of the schema's character limit in `tools.ts`. */
const MAX_SOURCE_BYTES = 20 * 1024;
const MAX_TITLE_LENGTH = 120;

const TAB = 0x09;
const LINE_FEED = 0x0a;
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;
const BYTE_ORDER_MARK = 0xfeff;

declare const normalizedSourceBrand: unique symbol;
declare const safeTitleBrand: unique symbol;

/**
 * Source in canonical form: no byte-order mark, LF endings, trimmed, no control characters,
 * within the size cap. Only `normalizeSource` can produce one.
 */
export type NormalizedD2Source = string & { readonly [normalizedSourceBrand]: true };

/** A single-line title of bounded length, safe to show beside the diagram. */
export type SafeTitle = string & { readonly [safeTitleBrand]: true };

export interface NormalizedSource {
  readonly text: NormalizedD2Source;
  readonly hash: string;
  readonly lineCount: number;
}

interface FoundControl {
  readonly offset: number;
  readonly codePoint: number;
}

/** Characters a terminal would act on rather than print. */
function isControl(codePoint: number): boolean {
  if (codePoint === TAB || codePoint === LINE_FEED) {
    return false;
  }
  return codePoint < FIRST_PRINTABLE || codePoint === DELETE;
}

function findControl(text: string): FoundControl | undefined {
  let offset = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isControl(codePoint)) {
      return { offset, codePoint };
    }
    offset += character.length;
  }
  return undefined;
}

/** Runs before anything inspects or renders, so the scanner and D2 see the same bytes. */
export function normalizeSource(raw: unknown): NormalizedSource {
  if (typeof raw !== "string") {
    throw new DiagramSourceError("Diagram source must be a string.", [
      { code: "D2_SOURCE", message: `Received ${raw === null ? "null" : typeof raw}.` },
    ]);
  }

  const text = stripByteOrderMark(raw).replace(/\r\n?/gu, "\n").trim();
  if (text.length === 0) {
    throw new DiagramSourceError("Diagram source is empty.", [
      { code: "D2_SOURCE", message: "Send D2 source such as `client -> gateway: request`." },
    ]);
  }

  const control = findControl(text);
  if (control) {
    const label = control.codePoint.toString(16).padStart(4, "0").toUpperCase();
    throw new DiagramSourceError("Diagram source contains a control character.", [
      {
        code: "D2_SOURCE",
        message: `U+${label} at offset ${control.offset} is not allowed in diagram source.`,
      },
    ]);
  }

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SOURCE_BYTES) {
    throw new DiagramSourceError("Diagram source is too large.", [
      {
        code: "D2_TOO_LARGE",
        message: `${bytes} bytes is above the ${MAX_SOURCE_BYTES} byte limit.`,
        hint: "Split it into smaller diagrams.",
      },
    ]);
  }

  return {
    text: text as NormalizedD2Source,
    hash: createHash("sha256").update(text, "utf8").digest("hex"),
    lineCount: text.split("\n").length,
  };
}

export function parseTitle(raw: unknown): SafeTitle | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const printable = Array.from(raw, (character) =>
    isControl(character.codePointAt(0) ?? 0) ? " " : character,
  ).join("");
  const title = printable.replace(/\s+/gu, " ").trim();
  if (title.length === 0) {
    return undefined;
  }
  const capped =
    title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 3)}...` : title;
  return capped as SafeTitle;
}

function stripByteOrderMark(raw: string): string {
  return raw.codePointAt(0) === BYTE_ORDER_MARK ? raw.slice(1) : raw;
}
