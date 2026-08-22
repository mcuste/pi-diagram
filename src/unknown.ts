import { removeTerminalControls } from "./terminal.js";

/** Formats an arbitrary value without invoking user-defined serialization hooks. */
export function describeUnknown(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") {
    return String(value);
  }
  if (typeof value === "symbol") {
    return "symbol";
  }
  if (typeof value === "function") {
    return "function";
  }
  return "object";
}

/** Preserves the original error unless it is an errno-shaped system failure. */
export function hasErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === code;
}

/** External error messages need no terminal control sequences. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? removeTerminalControls(error.message) : "unknown error";
}
