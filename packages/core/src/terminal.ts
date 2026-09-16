export interface TerminalControl {
  readonly offset: number;
  readonly codePoint: number;
}

const CONTROLS = /\p{Cc}/gu;

/** Control characters can change terminal state instead of showing text. */
export function findTerminalControl(
  text: string,
  allowLineFeed = false,
  allowTab = false,
): TerminalControl | undefined {
  for (const match of text.matchAll(CONTROLS)) {
    const character = match[0];
    if ((allowLineFeed && character === "\n") || (allowTab && character === "\t")) {
      continue;
    }
    return { offset: match.index, codePoint: character.codePointAt(0) ?? 0 };
  }
  return undefined;
}

/** Removes controls from diagnostics and other text emitted by external programs. */
export function removeTerminalControls(text: string, allowLineFeed = false): string {
  return text.replace(CONTROLS, (character) =>
    allowLineFeed && character === "\n" ? character : "",
  );
}

/** A space keeps words apart where a control character separated them. */
export function blankTerminalControls(text: string): string {
  return text.replace(CONTROLS, " ");
}

/** Returns a terminal-safe Error message, or `unknown error`. */
export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? removeTerminalControls(error.message) : "unknown error";
}

export function describeCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).padStart(4, "0").toUpperCase()}`;
}
