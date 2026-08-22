import { createHash } from "node:crypto";
import { DiagramSourceError } from "./d2/diagnostics.js";
import { describeCodePoint, findTerminalControl } from "./terminal.js";

/** Byte-level enforcement of the schema's character limit in `tools.ts`. */
const MAX_SOURCE_BYTES = 20 * 1024;
const MAX_TITLE_LENGTH = 120;

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
function findControl(text: string): FoundControl | undefined {
  return findTerminalControl(text, true, true);
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
    throw new DiagramSourceError("Diagram source contains a control character.", [
      {
        code: "D2_SOURCE",
        message: `${describeCodePoint(control.codePoint)} at offset ${control.offset} is not allowed in diagram source.`,
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
  if (raw.length > MAX_TITLE_LENGTH) {
    throw new DiagramSourceError("Diagram title is too long.", [
      {
        code: "D2_SOURCE",
        message: `${raw.length} characters is above the ${MAX_TITLE_LENGTH} character limit.`,
      },
    ]);
  }
  const printable = Array.from(raw, (character) =>
    findTerminalControl(character) === undefined ? character : " ",
  ).join("");
  const title = printable.replace(/\s+/gu, " ").trim();
  return title.length === 0 ? undefined : (title as SafeTitle);
}

function stripByteOrderMark(raw: string): string {
  return raw.codePointAt(0) === BYTE_ORDER_MARK ? raw.slice(1) : raw;
}
