export interface TerminalControl {
  readonly offset: number;
  readonly codePoint: number;
}

/** Control characters can change terminal state instead of showing text. */
export function findTerminalControl(
  text: string,
  allowLineFeed = false,
  allowTab = false,
): TerminalControl | undefined {
  let offset = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const allowed = (allowLineFeed && codePoint === 0x0a) || (allowTab && codePoint === 0x09);
    if (/\p{Cc}/u.test(character) && !allowed) {
      return { offset, codePoint };
    }
    offset += character.length;
  }
  return undefined;
}

/** Removes controls from diagnostics and other text emitted by external programs. */
export function removeTerminalControls(text: string, allowLineFeed = false): string {
  return Array.from(text, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return /\p{Cc}/u.test(character) && (!allowLineFeed || codePoint !== 0x0a) ? "" : character;
  }).join("");
}

export function describeCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).padStart(4, "0").toUpperCase()}`;
}
