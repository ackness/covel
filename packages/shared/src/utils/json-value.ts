/**
 * JSON wire-value boundary checks.
 *
 * The runtime I/O contract (docs 02 §2) allows only `JsonValue` across runtime
 * boundaries: activation payloads, binding values, exports, job data, envelope
 * values and persisted tool-call input/output. Anything else — `undefined`,
 * `bigint`, functions, symbols, `NaN` / `Infinity`, or circular references — is
 * rejected at the boundary.
 *
 * Two entry points share one walker:
 *  - `assertJsonValue` throws on the first offending node (used where the caller
 *    wants to fail the operation, e.g. `ctx.progress.report` job data).
 *  - `toJsonValueOrDiagnostic` never throws: a non-serialisable value collapses
 *    to a single bounded diagnostic string instead of writing an arbitrary
 *    object (used at the persisted `ToolCallRecord` boundary, where losing the
 *    payload is preferable to persisting something that cannot round-trip).
 *    Undefined object properties are omitted, as in JSON.stringify; undefined
 *    roots/array elements and other unsupported values remain diagnostics.
 *    Strict assertion/predicate callers do not permit this omission.
 */

import type { JsonValue } from "../types/runtime-scheduling.js";

/**
 * Walk `value` and throw if any node is not a JSON wire value. Cycle detection
 * is path-scoped (add on descent, remove on ascent), so a value shared by two
 * siblings is allowed — only a true back-reference is rejected.
 */
function walk(
  value: unknown,
  path: string,
  seen: Set<object>,
  omitUndefinedProperties = false,
): JsonValue {
  if (value === null) return null;
  const kind = typeof value;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (kind === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} is a non-finite number`);
    }
    return value as number;
  }
  if (kind !== "object") {
    // undefined, function, symbol, bigint
    throw new Error(`${path} is not JSON-serialisable (${kind})`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new Error(`${path} is circular`);
  seen.add(obj);
  let result: JsonValue;
  if (Array.isArray(obj)) {
    result = Array.from(obj, (v, i) =>
      walk(v, `${path}[${i}]`, seen, omitUndefinedProperties),
    );
  } else {
    const prototype = Object.getPrototypeOf(obj);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} is not a plain JSON object`);
    }
    result = Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .filter(([, v]) => !(omitUndefinedProperties && v === undefined))
        .map(([k, v]) => [
          k,
          walk(v, `${path}.${k}`, seen, omitUndefinedProperties),
        ]),
    );
  }
  seen.delete(obj);
  return result;
}

/** Throw if `value` is not a JSON wire value. `path` labels the throw message. */
export function assertJsonValue(value: unknown, path = "value"): void {
  walk(value, path, new Set());
}

/** True when `value` is a JSON wire value (no throw). */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    walk(value, "value", new Set());
    return true;
  } catch {
    return false;
  }
}

/**
 * Coerce to a JSON wire value, or return a single bounded diagnostic string
 * naming why it could not be represented. Never writes an arbitrary object.
 */
export function toJsonValueOrDiagnostic(
  value: unknown,
  label = "value",
): JsonValue {
  try {
    return walk(value, label, new Set(), true);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `[non-serialisable ${label}: ${reason}]`;
  }
}
