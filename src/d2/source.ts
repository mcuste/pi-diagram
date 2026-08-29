import { createHash } from "node:crypto";
import { describeCodePoint, findTerminalControl } from "../terminal.js";
import { DiagramSourceError, describeInvalidValue } from "./diagnostics.js";
import { inspect } from "./preflight.js";

/** Byte-level enforcement of the schema's character limit in `tools.ts`. */
const MAX_SOURCE_BYTES = 20 * 1024;
const MAX_TITLE_LENGTH = 120;

const BYTE_ORDER_MARK = 0xfeff;

declare const d2SourceBrand: unique symbol;
declare const safeTitleBrand: unique symbol;
declare const sourceHashBrand: unique symbol;

/** D2 source that passed normalization and safe-subset checks. */
export type D2Source = string & { readonly [d2SourceBrand]: true };

/** A single-line title of bounded length, safe to show beside the diagram. */
export type SafeTitle = string & { readonly [safeTitleBrand]: true };

/** A SHA-256 digest of normalized diagram source. */
export type SourceHash = string & { readonly [sourceHashBrand]: true };

export interface ParsedD2Source {
  readonly source: D2Source;
  readonly hash: SourceHash;
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
  return text;
}

export function parseTitle(raw: unknown): SafeTitle | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new DiagramSourceError("Diagram title must be a string.", [
      { code: "D2_SOURCE", message: `Received ${describeInvalidValue(raw)}.` },
    ]);
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
  if (title.length === 0) {
    throw new DiagramSourceError("Diagram title is empty.", [
      { code: "D2_SOURCE", message: "Give the diagram a non-empty title." },
    ]);
  }
  return title as SafeTitle;
}

/** Parses a digest before it becomes part of an artifact file name. */
export function parseSourceHash(raw: unknown): SourceHash {
  if (typeof raw === "string" && /^[a-f0-9]{64}$/u.test(raw)) {
    return raw as SourceHash;
  }
  throw new DiagramSourceError("Diagram source hash is not usable.", [
    { code: "D2_SOURCE", message: `Expected a SHA-256 digest, got ${describeInvalidValue(raw)}.` },
  ]);
}

function stripByteOrderMark(raw: string): string {
  return raw.codePointAt(0) === BYTE_ORDER_MARK ? raw.slice(1) : raw;
}
