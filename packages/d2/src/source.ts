import { createHash } from "node:crypto";
import {
  blankTerminalControls,
  DiagramSourceError,
  describeCodePoint,
  describeInvalidValue,
  findTerminalControl,
  parseSourceHash,
  refuse,
  type SourceHash,
} from "@mcuste/pi-diagram-core";
import { inspect } from "./preflight.js";

/** Byte-level enforcement of the schema's character limit in `tools.ts`. */
const MAX_SOURCE_BYTES = 20 * 1024;
/** The tool schema enforces the same limit on what the model may send. */
export const MAX_TITLE_LENGTH = 120;

const BYTE_ORDER_MARK = 0xfeff;

declare const d2SourceBrand: unique symbol;
declare const safeTitleBrand: unique symbol;

/** D2 source that passed normalization and safe-subset checks. */
export type D2Source = string & { readonly [d2SourceBrand]: true };

/** A single-line title of bounded length, safe to show beside the diagram. */
export type SafeTitle = string & { readonly [safeTitleBrand]: true };

export interface ParsedD2Source {
  readonly source: D2Source;
  readonly hash: SourceHash;
  readonly lineCount: number;
}

/** Parses model input into the only source type accepted by D2 renderers. */
export function parseD2Source(raw: unknown): ParsedD2Source {
  const text = normalizeSource(raw);
  const diagnostics = inspect(text);
  if (diagnostics.length > 0) {
    throw new DiagramSourceError(
      "Diagram source uses D2 features this tool does not allow.",
      diagnostics,
    );
  }
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  return {
    source: text as D2Source,
    hash: parseSourceHash(hash),
    lineCount: text.split("\n").length,
  };
}

function normalizeSource(raw: unknown): string {
  if (typeof raw !== "string") {
    refuse("Diagram source must be a string.", `Received ${describeInvalidValue(raw)}.`);
  }

  const text = stripByteOrderMark(raw).replace(/\r\n?/gu, "\n").trim();
  if (text.length === 0) {
    refuse("Diagram source is empty.", "Send D2 source such as `client -> gateway: request`.");
  }

  // Tabs and newlines are kept; anything else a terminal would act on is refused.
  const control = findTerminalControl(text, true, true);
  if (control) {
    refuse(
      "Diagram source contains a control character.",
      `${describeCodePoint(control.codePoint)} at offset ${control.offset} is not allowed in diagram source.`,
    );
  }

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SOURCE_BYTES) {
    refuse(
      "Diagram source is too large.",
      `${bytes} bytes is above the ${MAX_SOURCE_BYTES} byte limit.`,
      "Split it into smaller diagrams.",
      "D2_TOO_LARGE",
    );
  }
  return text;
}

export function parseTitle(raw: unknown): SafeTitle | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    refuse("Diagram title must be a string.", `Received ${describeInvalidValue(raw)}.`);
  }
  if (raw.length > MAX_TITLE_LENGTH) {
    refuse(
      "Diagram title is too long.",
      `${raw.length} characters is above the ${MAX_TITLE_LENGTH} character limit.`,
    );
  }
  const title = blankTerminalControls(raw).replace(/\s+/gu, " ").trim();
  if (title.length === 0) {
    refuse("Diagram title is empty.", "Give the diagram a non-empty title.");
  }
  return title as SafeTitle;
}

function stripByteOrderMark(raw: string): string {
  return raw.codePointAt(0) === BYTE_ORDER_MARK ? raw.slice(1) : raw;
}
