/**
 * One vocabulary for every refusal, including D2's own errors, so a policy rejection and a
 * syntax error read the same way and the model has one thing to correct.
 */

const MAX_DIAGNOSTICS = 10;
const MAX_MESSAGE_LENGTH = 200;

export type DiagnosticCode =
  | "D2_SOURCE"
  | "D2_TOO_LARGE"
  | "D2_TIMEOUT"
  | "D2_IMPORT"
  | "D2_ICON"
  | "D2_LINK"
  | "D2_IMAGE_SHAPE"
  | "D2_UNKNOWN_SHAPE"
  | "D2_BLOCK_STRING"
  | "D2_CONFIG"
  | "D2_UNTERMINATED"
  | "D2_SYNTAX"
  | "D2_RENDER";

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly hint?: string;
}

/** A refusal the model can fix by editing its source. What it cannot fix gets another type. */
export class DiagramSourceError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(summary: string, diagnostics: readonly Diagnostic[]) {
    const capped = diagnostics.slice(0, MAX_DIAGNOSTICS);
    super(capped.length > 0 ? `${summary}\n${formatDiagnostics(capped)}` : summary);
    this.name = "DiagramSourceError";
    this.diagnostics = capped;
  }
}

function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map(formatDiagnostic).join("\n");
}

function formatDiagnostic(diagnostic: Diagnostic): string {
  const at =
    diagnostic.line === undefined
      ? ""
      : diagnostic.column === undefined
        ? `line ${diagnostic.line}: `
        : `line ${diagnostic.line}, column ${diagnostic.column}: `;
  const hint = diagnostic.hint === undefined ? "" : ` ${diagnostic.hint}`;
  return `  ${at}${diagnostic.message}${hint} [${diagnostic.code}]`;
}

/** Prefixes D2 adds that do not help the model fix its source. */
const NOISE_PREFIXES = [/^err:\s*/u, /^failed to compile [^:]*:\s*/u, /^github\.com\/\S+:\s*/u];

const LOCATION = /(\d+):(\d+):\s*(.+)$/u;

/**
 * `secretPaths` are absolute paths from the isolated render directory. D2 puts them in render
 * errors, and they must not reach the model or the transcript.
 */
export function parseD2Diagnostics(
  stderr: string,
  code: DiagnosticCode,
  secretPaths: readonly string[],
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const rawLine of stderr.split("\n")) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      break;
    }
    const scrubbed = scrub(rawLine, secretPaths);
    if (scrubbed.length === 0) {
      continue;
    }
    const location = LOCATION.exec(scrubbed);
    if (location) {
      const [, line, column, message] = location;
      diagnostics.push({
        code,
        message: cap(message ?? scrubbed),
        line: Number(line),
        column: Number(column),
      });
      continue;
    }
    diagnostics.push({ code, message: cap(scrubbed) });
  }
  return diagnostics;
}

function scrub(line: string, secretPaths: readonly string[]): string {
  let text = line.trim();
  for (const prefix of NOISE_PREFIXES) {
    text = text.replace(prefix, "").trim();
  }
  for (const secret of secretPaths) {
    // Strip the directory before the file name so `<dir>/input.d2:2:6:` leaves `2:6:`.
    text = text.split(`${secret}/`).join("").split(secret).join("");
  }
  return text.replace(/^input\.d2:/u, "").trim();
}

function cap(message: string): string {
  const text = message.trim();
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}...` : text;
}
