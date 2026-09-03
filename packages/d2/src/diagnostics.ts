/** Parses D2's stderr into the shared diagnostic vocabulary. */

import {
  type Diagnostic,
  type DiagnosticCode,
  MAX_DIAGNOSTICS,
  removeTerminalControls,
} from "@mcuste/pi-diagram-core";

const MAX_MESSAGE_LENGTH = 200;

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
  let text = removeTerminalControls(line).trim();
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
