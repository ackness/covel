/**
 * The content digest a suspension compares to tell whether a record it will
 * write changed after it was taken (`SuspensionBasis.writes`).
 *
 * The digest is taken from the record's content, not from a row number: a
 * fork and a browser checkpoint rewrite every row of a session (and the write
 * order with them), and a suspension they copy must still compare equal when
 * nothing changed. Bookkeeping that such a copy rewrites — the session ID and
 * the timestamps — is left out. Object keys are sorted and properties holding
 * `undefined` are dropped, so every backend gives one digest for one content
 * (PostgreSQL `jsonb` returns keys in its own order).
 */

import { createHash } from "node:crypto";
import type { DataStore } from "../types.js";
import type { SuspensionWriteTarget } from "../records/snapshot-records.js";

/** The reads a digest needs; a `StoreTransaction` reads inside its transaction. */
export type SuspensionWriteReader = Pick<
  DataStore,
  "getPluginData" | "getCharacter" | "getCharacterSchema" | "getLorebookEntry"
>;

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function withoutBookkeeping(
  record: object & {
    readonly sessionId?: unknown;
    readonly createdAt?: unknown;
    readonly updatedAt?: unknown;
  },
): Record<string, unknown> {
  const {
    sessionId: _sessionId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...content
  } = record;
  return content;
}

async function readContent(
  reader: SuspensionWriteReader,
  sessionId: string,
  target: SuspensionWriteTarget,
): Promise<{ readonly content: unknown } | null> {
  switch (target.kind) {
    case "plugin-data": {
      const row = await reader.getPluginData(
        sessionId,
        target.pluginId,
        target.namespace,
        target.key,
      );
      return row ? { content: row.value } : null;
    }
    case "character": {
      const row = await reader.getCharacter(sessionId, target.id);
      return row ? { content: withoutBookkeeping(row) } : null;
    }
    case "character-schema": {
      const row = await reader.getCharacterSchema(sessionId);
      return row ? { content: withoutBookkeeping(row) } : null;
    }
    case "lorebook": {
      const row = await reader.getLorebookEntry(
        sessionId,
        { kind: "plugin", pluginId: target.pluginId },
        target.id,
      );
      return row ? { content: withoutBookkeeping(row) } : null;
    }
  }
}

/**
 * Digest of the record `target` names in `sessionId`, or null when there is
 * no such record. Two reads give the same digest exactly when the record's
 * content is the same.
 */
export async function readSuspensionWriteDigest(
  reader: SuspensionWriteReader,
  sessionId: string,
  target: SuspensionWriteTarget,
): Promise<string | null> {
  const read = await readContent(reader, sessionId, target);
  if (!read) return null;
  return createHash("sha256").update(canonicalJson(read.content)).digest("hex");
}
