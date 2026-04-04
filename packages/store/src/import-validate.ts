import type { StoreSnapshot } from "./types.js";

const REQUIRED_ARRAY_KEYS: ReadonlyArray<keyof StoreSnapshot["data"]> = [
  "worlds",
  "sessions",
  "messages",
  "characters",
  "events",
  "records",
  "snapshots",
];

/**
 * Validates that `data` has the expected StoreSnapshot shape before any
 * destructive operation (DELETE / clear) is performed.
 *
 * Throws a descriptive `TypeError` when validation fails so callers can
 * surface a clear error without wiping existing data first.
 */
export function validateImportData(data: unknown): asserts data is StoreSnapshot {
  if (data == null || typeof data !== "object") {
    throw new TypeError(
      `importAll: expected a StoreSnapshot object, got ${data === null ? "null" : typeof data}`,
    );
  }

  const record = data as Record<string, unknown>;

  if (!("data" in record) || record["data"] == null || typeof record["data"] !== "object") {
    throw new TypeError(
      "importAll: expected snapshot.data to be an object with collection arrays",
    );
  }

  const collections = record["data"] as Record<string, unknown>;

  for (const key of REQUIRED_ARRAY_KEYS) {
    if (!Array.isArray(collections[key])) {
      throw new TypeError(
        `importAll: expected snapshot.data.${key} to be an array, got ${
          collections[key] === null ? "null" : typeof collections[key]
        }`,
      );
    }
  }
}
