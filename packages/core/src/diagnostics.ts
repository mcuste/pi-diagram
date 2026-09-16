/**
 * One vocabulary for every refusal, including D2's own errors, so a policy rejection and a
 * syntax error read the same way and the model has one thing to correct.
 */

export const MAX_DIAGNOSTICS = 10;

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

/** Builds the common refusal: one summary and one diagnostic explaining it. */
export function sourceError(
  summary: string,
  message: string,
  hint?: string,
  code: DiagnosticCode = "D2_SOURCE",
): DiagramSourceError {
  return new DiagramSourceError(summary, [
    { code, message, ...(hint === undefined ? {} : { hint }) },
  ]);
}

/** Throws `sourceError`. Returns `never`, so a caller needs no early return after it. */
export function refuse(
  summary: string,
  message: string,
  hint?: string,
  code?: DiagnosticCode,
): never {
  throw sourceError(summary, message, hint, code);
}

/** One line, indented, the way it reads inside a refusal message. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const at =
    diagnostic.line === undefined
      ? ""
      : diagnostic.column === undefined
        ? `line ${diagnostic.line}: `
        : `line ${diagnostic.line}, column ${diagnostic.column}: `;
  const hint = diagnostic.hint === undefined ? "" : ` ${diagnostic.hint}`;
  return `  ${at}${diagnostic.message}${hint} [${diagnostic.code}]`;
}
