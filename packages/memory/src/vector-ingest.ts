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
 * is persisted alongside the vector index (a recall cursor + an archival content-hash map)
 * so a process restart does not re-embed everything.
 */

import {
  collectArchivalItems,
  type SearchablePluginDataResolver,
} from "./archival-items.js";
import type { VectorIngestStore } from "./store-contracts.js";

import type {
  CommitVectorIndexBatchInput,
  VectorStoreCapability,
} from "@covel/store/vector";
import { supportsVector } from "@covel/store/vector";

/** Store narrowed to one that can persist vectors. */
type VectorStore = VectorIngestStore & VectorStoreCapability;
type VectorIndexUpsert = NonNullable<
  CommitVectorIndexBatchInput["upserts"]
>[number];
import {
  ARCHIVAL_NAMESPACE,
  contentHash,
  type EmbedFn,
  MAX_INGEST_BATCH,
  MEMORY_VECTOR_PLUGIN_ID,
  RECALL_NAMESPACE,
} from "./vector-common.js";
import { retryTransientProviderCall } from "./provider-retry.js";

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
const HASHES_NS = "archival-ingest";

export interface VectorIngestor {
  /**
   * Embed-and-upsert everything new/changed for a session. Best-effort:
   * resolves to {@link IngestResult} on success, never throws on a store/embed
   * failure (it warns and returns whatever it managed to write).
   */
  ingest(sessionId: string): Promise<IngestResult>;
}

/** Cross-process coordinator injected by the server composition root. */
export type RunIngestExclusive = <T>(
  sessionId: string,
  task: () => Promise<T>,
) => Promise<T>;

/** A no-op ingestor for keyword-only deployments (no embed fn / no vector store). */
export function createNoopIngestor(): VectorIngestor {
  return { ingest: async () => SKIPPED };
}

export function createVectorIngestor(deps: {
  readonly store: VectorIngestStore;
  readonly embed: EmbedFn;
  readonly embeddingBatchSize?: number;
  readonly maxEmbeddingCharacters?: number;
  readonly runIngestExclusive?: RunIngestExclusive;
  readonly pluginData?: SearchablePluginDataResolver;
}): VectorIngestor {
  const { store, embed, runIngestExclusive, pluginData } = deps;
  interface PendingIngest {
    dirty: boolean;
    promise: Promise<IngestResult>;
  }
  const pendingBySession = new Map<string, PendingIngest>();

  const runSweep = async (
    sessionId: string,
  ): Promise<IngestResult & { more?: boolean }> => {
    if (!supportsVector(store)) return SKIPPED;

    const session = await store.getSession(sessionId);
    if (!session) return SKIPPED;
    // Bind every delayed embedding write to the session incarnation whose
    // source rows were read. A delete + same-id recreate during provider work
    // must not let the old sweep populate the new session's vector namespace.
    const expectedSessionCreatedAt = session.createdAt;

    let target;
    try {
      // No embedding model locked → RAG disabled for this session. Skip cleanly
      // so keyword search remains the (already-working) path.
      target = await store.resolveSessionVectorTarget(sessionId);
    } catch (err) {
      warn("target", sessionId, err);
      return { skipped: false, recall: 0, archival: 0 };
    }
    if (!target) return SKIPPED;

    let recall = 0;
    let archival = 0;
    let more = false;
    try {
      const result = await ingestRecall(
        store,
        (texts) => embed(texts, { sessionId, modelId: target.modelId }),
        sessionId,
        expectedSessionCreatedAt,
        {
          batchSize: deps.embeddingBatchSize,
          maxCharacters: deps.maxEmbeddingCharacters,
        },
      );
      recall = result.written;
      more ||= result.more;
    } catch (err) {
      warn("recall", sessionId, err);
    }
    try {
      const result = await ingestArchival(
        store,
        (texts) => embed(texts, { sessionId, modelId: target.modelId }),
        sessionId,
        expectedSessionCreatedAt,
        {
          batchSize: deps.embeddingBatchSize,
          maxCharacters: deps.maxEmbeddingCharacters,
        },
        pluginData,
      );
      archival = result.written;
      more ||= result.more;
    } catch (err) {
      warn("archival", sessionId, err);
    }
    return { skipped: false, recall, archival, more };
  };

  return {
    ingest(sessionId: string): Promise<IngestResult> {
      const pending = pendingBySession.get(sessionId);
      if (pending) {
        // The active sweep may already have read its cursor/hash snapshot. Mark
        // it dirty so one trailing pass observes data committed in that window.
        pending.dirty = true;
        return pending.promise;
      }

      // `promise` is replaced before the state is published in the map.
      const state: PendingIngest = {
        dirty: false,
        promise: Promise.resolve(SKIPPED),
      };
      const run = async (): Promise<IngestResult> => {
        let skipped = true;
        let recall = 0;
        let archival = 0;
        do {
          state.dirty = false;
          const result = await runSweep(sessionId);
          skipped = skipped && result.skipped;
          recall += result.recall;
          archival += result.archival;
          state.dirty ||= result.more ?? false;
        } while (state.dirty);
        return { skipped, recall, archival };
      };
      const coordinatedRun = runIngestExclusive
        ? () => runIngestExclusive(sessionId, run)
        : run;
      state.promise = coordinatedRun()
        .catch((error: unknown) => {
          warn("coordination", sessionId, error);
          return { skipped: false, recall: 0, archival: 0 };
        })
        .finally(() => {
          if (pendingBySession.get(sessionId) === state) {
            pendingBySession.delete(sessionId);
          }
        });
      pendingBySession.set(sessionId, state);
      return state.promise;
    },
  };
}

// ── Recall (turn messages, cursor-incremental) ───────────────────

async function ingestRecall(
  store: VectorStore,
  embed: (texts: readonly string[]) => Promise<readonly Float32Array[]>,
  sessionId: string,
  expectedSessionCreatedAt: string,
  limits: EmbeddingLimits,
): Promise<{ written: number; more: boolean }> {
  const progress = await readProgress<RecallCursor>(
    store,
    sessionId,
    CURSOR_NS,
  );
  const cursor = progress.value;

  // Keyset read of just the batch window past the cursor — the store orders by
  // the same `(createdAt, id)` total order the cursor is written in, so a long
  // session never streams its whole history through this per-turn sweep.
  const batch = await store.listTurnMessagesAfter(
    sessionId,
    cursor,
    MAX_INGEST_BATCH,
  );
  if (batch.length === 0) return { written: 0, more: false };

  const isEmbeddable = (m: { content?: unknown }): boolean =>
    Boolean(String(m.content ?? "").trim());
  const embeddable = batch.filter(isEmbeddable);
  const vectors = embeddable.length
    ? await embedWithRetry(
        embed,
        embeddable.map((m) => String(m.content)),
        sessionId,
        "recall",
        limits,
      )
    : [];

  const upserts: VectorIndexUpsert[] = [];
  // Advance the cursor only past messages we handled: persisted embeddings and
  // empty-content rows (which are never embeddable, so skipping them forward is
  // what keeps a run of blank rows from stalling the cursor forever). If
  // `embed` returns an empty/short array for some entry, stop WITHOUT moving
  // past it, so the next sweep retries it — otherwise a transient empty
  // embedding would silently drop that message from recall forever.
  let lastHandled: RecallCursor | null = null;
  let vectorIndex = 0;
  for (const msg of batch) {
    if (!isEmbeddable(msg)) {
      lastHandled = { createdAt: msg.createdAt, id: msg.id };
      continue;
    }
    const embedding = vectors[vectorIndex];
    vectorIndex += 1;
    if (embedding === null) {
      lastHandled = { createdAt: msg.createdAt, id: msg.id };
      continue;
    }
    if (!embedding || embedding.length === 0) break;
    upserts.push({
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
    lastHandled = { createdAt: msg.createdAt, id: msg.id };
  }

  if (lastHandled) {
    await commitIndexBatch(
      store,
      sessionId,
      CURSOR_NS,
      lastHandled,
      progress.raw,
      expectedSessionCreatedAt,
      { upserts },
    );
  }
  return {
    written: upserts.length,
    more:
      batch.length === MAX_INGEST_BATCH && lastHandled?.id === batch.at(-1)?.id,
  };
}

// ── Archival (lorebook + characters, hash-incremental) ───────────

async function ingestArchival(
  store: VectorStore,
  embed: (texts: readonly string[]) => Promise<readonly Float32Array[]>,
  sessionId: string,
  expectedSessionCreatedAt: string,
  limits: EmbeddingLimits,
  pluginData: SearchablePluginDataResolver | undefined,
): Promise<{ written: number; more: boolean }> {
  const items = await collectArchivalItems(store, sessionId, pluginData);

  const progress = await readProgress<ArchivalHashes>(
    store,
    sessionId,
    HASHES_NS,
  );
  const hashes = progress.value ?? {};

  // Read the complete corpus before removing anything. A source read failure
  // must preserve both existing vectors and progress.
  const liveKeys = new Set(items.map((it) => it.vecKey));
  const removedKeys = Object.keys(hashes).filter((key) => !liveKeys.has(key));
  const hasDeletion = removedKeys.length > 0;
  const deletes = removedKeys.map((key) => ({
    namespace: ARCHIVAL_NAMESPACE,
    key,
  }));
  for (const key of removedKeys) {
    delete hashes[key];
  }

  // Embed only items whose content fingerprint is new or changed.
  const changed = items.filter(
    (it) => hashes[it.vecKey] !== contentHash(it.text),
  );
  if (changed.length === 0) {
    if (hasDeletion)
      await commitIndexBatch(
        store,
        sessionId,
        HASHES_NS,
        hashes,
        progress.raw,
        expectedSessionCreatedAt,
        { deletes },
      );
    return { written: 0, more: false };
  }

  const batch = changed.slice(0, MAX_INGEST_BATCH);
  const vectors = await embedWithRetry(
    embed,
    batch.map((it) => it.text),
    sessionId,
    "archival",
    limits,
  );

  const nextHashes: ArchivalHashes = { ...hashes };
  const upserts: VectorIndexUpsert[] = [];
  for (const [i, it] of batch.entries()) {
    const embedding = vectors[i];
    if (embedding === null) {
      nextHashes[it.vecKey] = contentHash(it.text);
      deletes.push({ namespace: ARCHIVAL_NAMESPACE, key: it.vecKey });
      continue;
    }
    if (!embedding || embedding.length === 0) continue;
    upserts.push({
      namespace: ARCHIVAL_NAMESPACE,
      key: it.vecKey,
      embedding,
      payload: JSON.stringify({
        source: it.source,
        key: it.displayKey,
        content: it.text,
        ...(it.pluginId ? { pluginId: it.pluginId } : {}),
        ...(it.namespace ? { namespace: it.namespace } : {}),
      }),
    });
    nextHashes[it.vecKey] = contentHash(it.text);
  }

  await commitIndexBatch(
    store,
    sessionId,
    HASHES_NS,
    nextHashes,
    progress.raw,
    expectedSessionCreatedAt,
    { upserts, deletes },
  );
  return {
    written: upserts.length,
    more:
      changed.length > batch.length &&
      batch.every(
        (_, i) => vectors[i] === null || (vectors[i]?.length ?? 0) > 0,
      ),
  };
}

// Index progress is deliberately absent from business-data snapshots/checkpoints.
async function readProgress<T>(
  store: VectorStore,
  sessionId: string,
  namespace: string,
): Promise<{ value: T | null; raw: string | null }> {
  const raw = await store.getVectorIndexProgress({
    sessionId,
    pluginId: MEMORY_VECTOR_PLUGIN_ID,
    namespace,
  });
  return { raw, value: raw === null ? null : (JSON.parse(raw) as T) };
}

async function commitIndexBatch(
  store: VectorStore,
  sessionId: string,
  namespace: string,
  value: unknown,
  expectedValue: string | null,
  expectedSessionCreatedAt: string,
  changes: Pick<CommitVectorIndexBatchInput, "upserts" | "deletes">,
): Promise<void> {
  const updated = await store.commitVectorIndexBatch({
    sessionId,
    pluginId: MEMORY_VECTOR_PLUGIN_ID,
    namespace,
    value: JSON.stringify(value),
    expectedValue,
    expectedSessionCreatedAt,
    ...changes,
  });
  if (!updated)
    throw new Error("Vector index progress changed during ingestion");
}

function warn(kind: string, sessionId: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[memory] vector ingest (${kind}) failed for ${sessionId}: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}

interface EmbeddingLimits {
  readonly batchSize?: number;
  readonly maxCharacters?: number;
}

/** Only an explicit per-input rejection can be skipped; config/auth failures retain progress. */
function rejectedEmbeddingInput(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const details = record.details as Record<string, unknown> | undefined;
  const code = String(details?.providerCode ?? record.code ?? "").toLowerCase();
  return (
    record.statusCode === 413 ||
    record.status === 413 ||
    [
      "context_length_exceeded",
      "input_too_long",
      "invalid_input",
      "content_filter",
    ].includes(code)
  );
}

async function embedWithRetry(
  embed: (texts: readonly string[]) => Promise<readonly Float32Array[]>,
  texts: readonly string[],
  sessionId: string,
  kind: "recall" | "archival",
  limits: EmbeddingLimits,
): Promise<readonly (Float32Array | null | undefined)[]> {
  const batchSize = Math.max(
    1,
    Math.min(
      MAX_INGEST_BATCH,
      Math.floor(Number.isFinite(limits.batchSize) ? limits.batchSize! : 16),
    ),
  );
  const maxCharacters = Math.max(
    1,
    Math.floor(
      Number.isFinite(limits.maxCharacters) ? limits.maxCharacters! : 8000,
    ),
  );
  const run = async (
    batch: readonly string[],
  ): Promise<(Float32Array | null | undefined)[]> => {
    try {
      const vectors = await retryTransientProviderCall(() => embed(batch), {
        onRetry: (error, nextAttempt) => {
          console.warn(
            `[memory] vector ingest (${kind}) provider call failed for ${sessionId}; retrying attempt ${nextAttempt}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      });
      return batch.map((_, i) => vectors[i]);
    } catch (error) {
      if (!rejectedEmbeddingInput(error)) throw error;
      if (batch.length === 1) {
        console.warn(
          `[memory] vector ingest (${kind}) skipped a rejected input for ${sessionId}`,
        );
        return [null];
      }
      const middle = Math.floor(batch.length / 2);
      return [
        ...(await run(batch.slice(0, middle))),
        ...(await run(batch.slice(middle))),
      ];
    }
  };
  const vectors: (Float32Array | null | undefined)[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    vectors.push(
      ...(await run(
        texts
          .slice(i, i + batchSize)
          .map((text) => text.slice(0, maxCharacters)),
      )),
    );
  }
  return vectors;
}
