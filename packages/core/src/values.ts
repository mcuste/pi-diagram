/** Checks and descriptions for values that arrive from the model or the host. */

/** True for a plain object. Arrays are excluded, because no caller accepts one. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Describes an invalid value without calling its methods. */
export function describeInvalidValue(value: unknown): string {
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

/** Keeps an inherited property from becoming an argument. */
export function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
