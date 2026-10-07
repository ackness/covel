/**
 * U+0000 removed from a value on its way into a store.
 *
 * PostgreSQL holds the character in neither a `text` nor a `jsonb` column: it
 * fails the statement, and with it the transaction that commits a turn. Text a
 * model wrote can contain it. Every backend drops it instead, so one value
 * reads back the same from MemoryStore, SQLite and PostgreSQL.
 *
 * A string is cleaned wherever it sits: on its own, as an array element, as an
 * object's value or as its key. A value that is not a string, an array or a
 * plain object (the typed array of an embedding, a query fragment) is returned
 * as it is, and a value without the character is returned without a copy.
 */

const NUL = "\u0000";

const IDENTITY_FIELDS = new Set([
  "id",
  "sessionId",
  "worldId",
  "pluginId",
  "runtimeId",
  "turnId",
  "traceId",
  "namespace",
  "key",
  "tableName",
  "fieldName",
  "producerRuntimeId",
  "recordAs",
  "jobId",
  "progressScopeId",
  "logicalTurnId",
  "generation",
  "suspensionId",
]);

/** Keys must not be rewritten: removing NUL could address a different record. */
export function assertStoreIdentifiers(value: unknown): void {
  if (typeof value === "string") {
    if (value.includes(NUL))
      throw new Error("Store identifier must not contain U+0000");
  } else if (Array.isArray(value)) {
    for (const item of value) assertStoreIdentifiers(item);
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (
        IDENTITY_FIELDS.has(key) &&
        typeof item === "string" &&
        item.includes(NUL)
      )
        throw new Error(`Store identifier ${key} must not contain U+0000`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clean(value: unknown): unknown {
  if (typeof value === "string") {
    return value.includes(NUL) ? value.replaceAll(NUL, "") : value;
  }
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    for (let i = 0; i < value.length; i += 1) {
      const item = clean(value[i]);
      if (item !== value[i]) (copy ??= [...value])[i] = item;
    }
    return copy ?? value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const entry: [string, unknown] = [clean(key) as string, clean(item)];
      if (entry[0] !== key || entry[1] !== item) changed = true;
      return entry;
    });
    if (changed && new Set(entries.map(([key]) => key)).size !== entries.length)
      throw new Error("Removing U+0000 would produce duplicate JSON keys");
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}

export function withoutNul<T>(value: T): T {
  return clean(value) as T;
}
