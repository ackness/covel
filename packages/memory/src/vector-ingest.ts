/**
 * Embed-on-write ingestion — the missing half of semantic memory.
 *
 * The store's vector capability (`upsertVector` / `searchVectors`) and the
 * injected `embed` function both exist; this module is what actually *fills*
 * the per-session vector tables so a vector searcher has something to find.
 *
 * Strategy: a **post-turn best-effort sweep**, not a per-write hook. Each sweep
 * reads the same corpus the keyword searchers read — turn messages (recall) and
 * lorebook + character records (archival) — embeds whatever is new or changed
 * since the last sweep, and upserts it. This single mechanism covers both
 * steady-state ingestion (the delta each turn) AND cold-start backfill (an
 * existing session's first sweep embeds its whole history, bounded per pass).
 *
 * It must never block or fail a turn: callers fire-and-forget it after commit,
 * and every store/embed error is swallowed with a warning. Incremental progress
 * is persisted in `plugin_data` (a recall cursor + an archival content-hash map)
 * so a process restart does not re-embed everything.
 */

import type { DataStore, VectorStoreCapability } from "@covel/store";
import { supportsVector } from "@covel/store";

/** Store narrowed to one that can persist vectors. */
type VectorStore = DataStore & VectorStoreCapability;
import {
  ARCHIVAL_NAMESPACE,
  contentHash,
  type EmbedFn,
  MAX_INGEST_BATCH,
  MEMORY_VECTOR_PLUGIN_ID,
  RECALL_NAMESPACE,
} from "./vector-common.js";

/** Outcome of one ingestion sweep. */
export interface IngestResult {
  /** True when no vector backend / no embedding model — nothing was attempted. */
  readonly skipped: boolean;
  /** Number of recall (turn-message) vectors written this sweep. */
  readonly recall: number;
  /** Number of archival (lorebook + character) vectors written this sweep. */
  readonly archival: number;
}

const SKIPPED: IngestResult = { skipped: true, recall: 0, archival: 0 };

/** Persisted recall progress cursor: last embedded message `(createdAt, id)`. */
interface RecallCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** Persisted archival fingerprints: vector key → content hash at embed time. */
type ArchivalHashes = Record<string, string>;

const CURSOR_NS = "recall-ingest";
const CURSOR_KEY = "cursor";
const HASHES_NS = "archival-ingest";
const HASHES_KEY = "hashes";

export interface VectorIngestor {
  /**
   * Embed-and-upsert everything new/changed for a session. Best-effort:
   * resolves to {@link IngestResult} on success, never throws on a store/embed
   * failure (it warns and returns whatever it managed to write).
   */
  ingest(sessionId: string): Promise<IngestResult>;
}

/** A no-op ingestor for keyword-only deployments (no embed fn / no vector store). */
export function createNoopIngestor(): VectorIngestor {
  return { ingest: async () => SKIPPED };
}

export function createVectorIngestor(deps: {
  readonly store: DataStore;
  readonly embed: EmbedFn;
}): VectorIngestor {
  const { store, embed } = deps;

  return {
    async ingest(sessionId: string): Promise<IngestResult> {
      if (!supportsVector(store)) return SKIPPED;

      // No embedding model locked → RAG disabled for this session. Skip cleanly
      // so keyword search remains the (already-working) path.
      const target = await store.resolveSessionVectorTarget(sessionId);
      if (!target) return SKIPPED;

      let recall = 0;
      let archival = 0;
      try {
        recall = await ingestRecall(store, embed, sessionId);
      } catch (err) {
        warn("recall", sessionId, err);
      }
      try {
        archival = await ingestArchival(store, embed, sessionId);
      } catch (err) {
        warn("archival", sessionId, err);
      }
      return { skipped: false, recall, archival };
    },
  };
}

// ── Recall (turn messages, cursor-incremental) ───────────────────

async function ingestRecall(
  store: VectorStore,
  embed: EmbedFn,
  sessionId: string,
): Promise<number> {
  const messages = (await store.listTurnMessages(sessionId)).filter((m) =>
    String(m.content ?? "").trim(),
  );
  if (messages.length === 0) return 0;

  // Deterministic order (createdAt, id) so a same-millisecond tie cannot make
  // the cursor skip a message across backends with different secondary sorts.
  const sorted = [...messages].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  const cursor = await readPluginJson<RecallCursor>(
    store,
    sessionId,
    CURSOR_NS,
    CURSOR_KEY,
  );

  const pending = sorted.filter((m) => isAfterCursor(m, cursor));
  if (pending.length === 0) return 0;

  const batch = pending.slice(0, MAX_INGEST_BATCH);
  const vectors = await embed(batch.map((m) => String(m.content)));

  let written = 0;
  for (let i = 0; i < batch.length; i += 1) {
    const msg = batch[i];
    const embedding = vectors[i];
    if (!embedding || embedding.length === 0) continue;
    await store.upsertVector({
      sessionId,
      pluginId: MEMORY_VECTOR_PLUGIN_ID,
      namespace: RECALL_NAMESPACE,
      key: msg.id,
      embedding,
      payload: JSON.stringify({
        turnId: msg.turnId ?? "",
        role: msg.role,
        content: String(msg.content),
        createdAt: msg.createdAt,
      }),
    });
    written += 1;
  }

  const last = batch[batch.length - 1];
  await writePluginJson<RecallCursor>(store, sessionId, CURSOR_NS, CURSOR_KEY, {
    createdAt: last.createdAt,
    id: last.id,
  });
  return written;
}

function isAfterCursor(
  msg: { createdAt: string; id: string },
  cursor: RecallCursor | null,
): boolean {
  if (!cursor) return true;
  if (msg.createdAt !== cursor.createdAt) {
    return msg.createdAt > cursor.createdAt;
  }
  return msg.id > cursor.id;
}

// ── Archival (lorebook + characters, hash-incremental) ───────────

interface ArchivalItem {
  readonly vecKey: string;
  readonly displayKey: string;
  readonly text: string;
  readonly source: "lorebook" | "character";
  readonly pluginId?: string;
}

async function ingestArchival(
  store: VectorStore,
  embed: EmbedFn,
  sessionId: string,
): Promise<number> {
  const items = await collectArchivalItems(store, sessionId);
  if (items.length === 0) return 0;

  const hashes =
    (await readPluginJson<ArchivalHashes>(
      store,
      sessionId,
      HASHES_NS,
      HASHES_KEY,
    )) ?? {};

  // Embed only items whose content fingerprint is new or changed.
  const changed = items.filter(
    (it) => hashes[it.vecKey] !== contentHash(it.text),
  );
  if (changed.length === 0) return 0;

  const batch = changed.slice(0, MAX_INGEST_BATCH);
  const vectors = await embed(batch.map((it) => it.text));

  const nextHashes: ArchivalHashes = { ...hashes };
  let written = 0;
  for (let i = 0; i < batch.length; i += 1) {
    const it = batch[i];
    const embedding = vectors[i];
    if (!embedding || embedding.length === 0) continue;
    await store.upsertVector({
      sessionId,
      pluginId: MEMORY_VECTOR_PLUGIN_ID,
      namespace: ARCHIVAL_NAMESPACE,
      key: it.vecKey,
      embedding,
      payload: JSON.stringify({
        source: it.source,
        key: it.displayKey,
        content: it.text,
        ...(it.pluginId ? { pluginId: it.pluginId } : {}),
      }),
    });
    nextHashes[it.vecKey] = contentHash(it.text);
    written += 1;
  }

  await writePluginJson<ArchivalHashes>(
    store,
    sessionId,
    HASHES_NS,
    HASHES_KEY,
    nextHashes,
  );
  return written;
}

async function collectArchivalItems(
  store: DataStore,
  sessionId: string,
): Promise<ArchivalItem[]> {
  const items: ArchivalItem[] = [];

  // Lorebook entries. plugin_data is intentionally excluded (same isolation
  // reasoning as the keyword archival searcher — no plugin-agnostic way to scan
  // every plugin's namespaced data).
  if (typeof store.listSessionLorebookEntries === "function") {
    try {
      const entries = await store.listSessionLorebookEntries(sessionId);
      for (const entry of entries) {
        const content = String(entry.content ?? "").trim();
        if (!content) continue;
        items.push({
          vecKey: `lorebook:${entry.id}`,
          displayKey: entry.keys?.[0] ?? entry.id,
          text: content,
          source: "lorebook",
          ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
        });
      }
    } catch {
      // Non-fatal — backend may not support lorebook.
    }
  }

  // Character records.
  try {
    const characters = await store.listCharacters(sessionId);
    for (const char of characters) {
      const text =
        `[${char.type}] ${char.name}: ${char.description ?? ""} ${JSON.stringify(char.fields ?? {})}`.trim();
      if (!text) continue;
      items.push({
        vecKey: `character:${char.id}`,
        displayKey: char.name,
        text,
        source: "character",
      });
    }
  } catch {
    // Non-fatal.
  }

  return items;
}

// ── plugin_data cursor helpers ───────────────────────────────────

async function readPluginJson<T>(
  store: DataStore,
  sessionId: string,
  namespace: string,
  key: string,
): Promise<T | null> {
  const rec = await store.getPluginData(
    sessionId,
    MEMORY_VECTOR_PLUGIN_ID,
    namespace,
    key,
  );
  return (rec?.value as T | undefined) ?? null;
}

async function writePluginJson<T>(
  store: DataStore,
  sessionId: string,
  namespace: string,
  key: string,
  value: T,
): Promise<void> {
  const now = new Date().toISOString();
  await store.setPluginData({
    id: `${MEMORY_VECTOR_PLUGIN_ID}:${namespace}:${key}:${sessionId}`,
    sessionId,
    pluginId: MEMORY_VECTOR_PLUGIN_ID,
    namespace,
    key,
    value,
    createdAt: now,
    updatedAt: now,
  });
}

function warn(kind: string, sessionId: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[memory] vector ingest (${kind}) failed for ${sessionId}: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}
