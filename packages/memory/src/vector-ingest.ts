import { payloadContent } from "./vector-common.js";
/**
 * Embed-on-write ingestion — the missing half of semantic memory.
 *
 * The store's vector capability (`upsertVector` / `searchVectors`) and the
 * injected `embed` function both exist; this module is what actually *fills*
 * the per-session vector tables so a vector searcher has something to find.
 *
 * Strategy: a **post-turn best-effort sweep**, not a per-write hook. Each sweep
 * reads what was saved since the last sweep, embeds it and upserts it:
 *
 *  - recall: turn messages past a cursor on their save order (`writeSeq`);
 *  - archival: the store's change feed of lorebook entries, characters and
 *    plugin data (`listRecordChanges`), past a cursor on the same order. A
 *    change names a record; the sweep reads that record and embeds it, or
 *    deletes its vector when the record is gone or yields no text.
 *
 * The same walk covers steady-state ingestion (the delta each turn) and a
 * cold-start backfill (an existing session's first sweep starts at the
 * beginning, bounded per pass). Neither reads the whole history.
 *
 * It must never block or fail a turn: callers fire-and-forget it after commit,
 * and every store/embed error is swallowed with a warning. Progress is
 * persisted alongside the vector index and moves only past what a sweep
 * handled, so a failed read or embedding is retried by the next sweep and a
 * process restart does not re-embed everything.
 */

import {
  archivalVecKey,
  readArchivalItem,
  searchableSourceKey,
  type ArchivalItem,
  type SearchablePluginData,
  type SearchablePluginDataResolver,
} from "./archival-items.js";
import type { VectorIngestStore } from "./store-contracts.js";

import type { RecordChange } from "@covel/store/contracts";
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
  type EmbedFn,
  isEmbeddingModelChanged,
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

/** Persisted recall progress: the `writeSeq` of the last message handled. */
interface RecallProgress {
  readonly writeSeq: number;
}

/** A searchable plugin data namespace as progress records it: `[pluginId, namespace, textField]`. */
type SourceTuple = readonly [string, string, string];

/**
 * A namespace that became searchable after the index had passed its records
 * (`add`: walk its changes up to `through`), or stopped being searchable
 * (`remove`: delete the vector of every record it ever had).
 */
interface SourceJob {
  readonly source: SourceTuple;
  readonly remove: boolean;
  /** Last change of the walk handled; null before the first. */
  readonly after: number | null;
  readonly through?: number;
}

/** Persisted archival progress. */
interface ArchivalProgress {
  /** `seq` of the last change of the session's records handled; null before the first. */
  readonly cursor: number | null;
  /** The searchable plugin data namespaces the index holds. */
  readonly sources: readonly SourceTuple[];
  readonly jobs: readonly SourceJob[];
}

/**
 * What a sweep's writes are bound to: the session incarnation whose rows it
 * read and the model it embedded with. A batch that no longer matches either
 * is refused by the store.
 */
interface IndexGuard {
  readonly expectedSessionCreatedAt: string;
  readonly expectedModelRegistryId: number;
}

const CURSOR_NS = "recall-ingest";
const ARCHIVAL_NS = "archival-ingest";

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

  // A session whose index was built with a model the configuration no longer
  // selects fails every sweep the same way; say so once per locked model.
  const warnedModelChanges = new Set<string>();
  const modelChanged = (
    sessionId: string,
    modelId: string,
    err: unknown,
  ): IngestResult => {
    const key = JSON.stringify([sessionId, modelId]);
    if (!warnedModelChanges.has(key)) {
      warnedModelChanges.add(key);
      warn("model", sessionId, err);
    }
    return { skipped: false, recall: 0, archival: 0 };
  };

  const runSweep = async (
    sessionId: string,
  ): Promise<IngestResult & { more?: boolean }> => {
    if (!supportsVector(store)) return SKIPPED;

    const session = await store.getSession(sessionId);
    if (!session) return SKIPPED;

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
    // Bind every delayed embedding write to the session incarnation whose
    // source rows were read, and to the model it embeds with. A delete +
    // same-id recreate, or an index reset to another model, during provider
    // work must not let this sweep write into the new index.
    const guard: IndexGuard = {
      expectedSessionCreatedAt: session.createdAt,
      expectedModelRegistryId: target.modelRegistryId,
    };

    let recall = 0;
    let archival = 0;
    let more = false;
    try {
      const result = await ingestRecall(
        store,
        (texts) => embed(texts, { sessionId, modelId: target.modelId }),
        sessionId,
        guard,
        {
          batchSize: deps.embeddingBatchSize,
          maxCharacters: deps.maxEmbeddingCharacters,
        },
      );
      recall = result.written;
      more ||= result.more;
    } catch (err) {
      if (isEmbeddingModelChanged(err))
        return modelChanged(sessionId, target.modelId, err);
      warn("recall", sessionId, err);
    }
    try {
      const result = await ingestArchival(
        store,
        (texts) => embed(texts, { sessionId, modelId: target.modelId }),
        sessionId,
        guard,
        {
          batchSize: deps.embeddingBatchSize,
          maxCharacters: deps.maxEmbeddingCharacters,
        },
        pluginData,
      );
      archival = result.written;
      more ||= result.more;
    } catch (err) {
      if (isEmbeddingModelChanged(err))
        return modelChanged(sessionId, target.modelId, err);
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

// ── Recall (turn messages, save-order cursor) ────────────────────

async function ingestRecall(
  store: VectorStore,
  embed: (texts: readonly string[]) => Promise<readonly Float32Array[]>,
  sessionId: string,
  guard: IndexGuard,
  limits: EmbeddingLimits,
): Promise<{ written: number; more: boolean }> {
  const progress = await readProgress<RecallProgress>(
    store,
    sessionId,
    CURSOR_NS,
  );

  // The batch window past the cursor, in save order. A message is never
  // visible before one saved earlier, so nothing behind the cursor can appear
  // later — even a background execution's message with an older createdAt.
  const batch = await store.listTurnMessagesAfter(
    sessionId,
    progress.value?.writeSeq ?? null,
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
  let lastHandled: number | null = null;
  let vectorIndex = 0;
  for (const msg of batch) {
    if (!isEmbeddable(msg)) {
      lastHandled = msg.writeSeq;
      continue;
    }
    const embedding = vectors[vectorIndex];
    vectorIndex += 1;
    if (embedding === null) {
      lastHandled = msg.writeSeq;
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
    lastHandled = msg.writeSeq;
  }

  if (lastHandled !== null) {
    await commitIndexBatch(
      store,
      sessionId,
      CURSOR_NS,
      { writeSeq: lastHandled } satisfies RecallProgress,
      progress.raw,
      guard,
      { upserts },
    );
  }
  return {
    written: upserts.length,
    more:
      batch.length === MAX_INGEST_BATCH &&
      lastHandled === batch.at(-1)?.writeSeq,
  };
}

// ── Archival (lorebook + characters + plugin data, change feed) ──

const sourceTuple = (source: SearchablePluginData): SourceTuple => [
  source.pluginId,
  source.namespace,
  source.textField,
];
const tupleKey = (tuple: SourceTuple): string => JSON.stringify(tuple);

/**
 * Compare the namespaces the index holds with the ones searchable now. A new
 * one is walked from its first record up to the cursor (the main walk covers
 * what comes after); one no longer searchable has every vector of its records
 * removed. Before the first change is handled, the main walk covers it all.
 */
function reconcileSources(
  progress: ArchivalProgress,
  current: readonly SearchablePluginData[],
): ArchivalProgress {
  const now = new Map(current.map((s) => [tupleKey(sourceTuple(s)), s]));
  const before = new Set(progress.sources.map(tupleKey));
  let jobs = [...progress.jobs];
  for (const tuple of progress.sources) {
    const key = tupleKey(tuple);
    if (now.has(key)) continue;
    jobs = jobs.filter((job) => tupleKey(job.source) !== key);
    jobs.push({ source: tuple, remove: true, after: null });
  }
  for (const [key, source] of now) {
    if (before.has(key)) continue;
    jobs = jobs.filter((job) => tupleKey(job.source) !== key);
    if (progress.cursor !== null)
      jobs.push({
        source: sourceTuple(source),
        remove: false,
        after: null,
        through: progress.cursor,
      });
  }
  return {
    cursor: progress.cursor,
    sources: [...now.values()].map(sourceTuple),
    // Removals first: a namespace whose text field changed is removed and
    // added again under the same vector keys.
    jobs: [
      ...jobs.filter((job) => job.remove),
      ...jobs.filter((j) => !j.remove),
    ],
  };
}

async function ingestArchival(
  store: VectorStore,
  embed: (texts: readonly string[]) => Promise<readonly Float32Array[]>,
  sessionId: string,
  guard: IndexGuard,
  limits: EmbeddingLimits,
  pluginData: SearchablePluginDataResolver | undefined,
): Promise<{ written: number; more: boolean }> {
  const progress = await readProgress<ArchivalProgress>(
    store,
    sessionId,
    ARCHIVAL_NS,
  );
  const searchable = pluginData ? await pluginData(sessionId) : [];
  const sources = new Map(
    searchable.map((s) => [searchableSourceKey(s.pluginId, s.namespace), s]),
  );
  const state = reconcileSources(
    progress.value ?? { cursor: null, sources: [], jobs: [] },
    searchable,
  );
  const deletes: { namespace: string; key: string }[] = [];
  let budget = MAX_INGEST_BATCH;

  // Removals only delete vectors. Nothing is embedded until they are done, so
  // an addition under the same keys cannot be deleted after it is written.
  const jobs: SourceJob[] = [];
  for (const job of state.jobs) {
    if (!job.remove || budget === 0) {
      jobs.push(job);
      continue;
    }
    const [pluginId, namespace] = job.source;
    const limit = budget;
    const page = await store.listRecordChanges(sessionId, {
      after: job.after,
      pluginData: { pluginId, namespace },
      limit,
    });
    budget -= page.length;
    for (const change of page) deletes.push(vectorRef(change));
    // A short page is the end of the namespace: the job is done.
    if (page.length === limit) jobs.push({ ...job, after: page.at(-1)!.seq });
  }
  if (jobs.some((job) => job.remove)) {
    await commitArchival(store, sessionId, progress.raw, guard, {
      state: { ...state, jobs },
      deletes,
    });
    return { written: 0, more: true };
  }

  // The changes to handle this sweep: additions first, then the main walk.
  interface Walk {
    readonly job: SourceJob | null;
    readonly changes: RecordChange[];
    readonly full: boolean;
  }
  const walks: Walk[] = [];
  for (const job of jobs) {
    if (budget === 0) {
      walks.push({ job, changes: [], full: true });
      continue;
    }
    const [pluginId, namespace] = job.source;
    const changes = await store.listRecordChanges(sessionId, {
      after: job.after,
      ...(job.through === undefined ? {} : { through: job.through }),
      pluginData: { pluginId, namespace },
      limit: budget,
    });
    walks.push({ job, changes, full: changes.length === budget });
    budget -= changes.length;
  }
  const main =
    budget === 0
      ? []
      : await store.listRecordChanges(sessionId, {
          after: state.cursor,
          limit: budget,
        });
  walks.push({ job: null, changes: main, full: main.length === budget });

  // Read each changed record once. A failed read throws: progress stays put.
  const items = new Map<string, ArchivalItem | null>();
  for (const walk of walks) {
    for (const change of walk.changes) {
      const key = vectorRef(change).key;
      if (!items.has(key))
        items.set(
          key,
          await readArchivalItem(store, sessionId, change, sources),
        );
    }
  }
  // Skip a record whose text the index already holds.
  const stored = await store.getVectorPayloads({
    sessionId,
    pluginId: MEMORY_VECTOR_PLUGIN_ID,
    namespace: ARCHIVAL_NAMESPACE,
    keys: [...items.keys()],
  });
  // A source removal may delete these keys in this same batch. Its replacement
  // must restore them even when the new text field contains identical text.
  for (const deletion of deletes) stored.delete(deletion.key);
  const toEmbed: ArchivalItem[] = [];
  for (const [key, item] of items) {
    if (!item) {
      if (stored.has(key)) deletes.push({ namespace: ARCHIVAL_NAMESPACE, key });
    } else if (payloadContent(stored.get(key)) !== item.text) {
      toEmbed.push(item);
    }
  }
  const vectors = toEmbed.length
    ? await embedWithRetry(
        embed,
        toEmbed.map((it) => it.text),
        sessionId,
        "archival",
        limits,
      )
    : [];
  const upserts: VectorIndexUpsert[] = [];
  const failed = new Set<string>();
  for (const [i, it] of toEmbed.entries()) {
    const embedding = vectors[i];
    if (embedding === null) {
      // A rejected input is not retried; its old text must not stay findable.
      if (stored.has(it.vecKey))
        deletes.push({ namespace: ARCHIVAL_NAMESPACE, key: it.vecKey });
      continue;
    }
    if (!embedding || embedding.length === 0) {
      failed.add(it.vecKey);
      continue;
    }
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
  }

  // Each walk moves past the changes it handled, up to the first one whose
  // embedding came back empty; that one is retried by the next sweep.
  let stopped = false;
  let more = false;
  let cursor = state.cursor;
  const nextJobs: SourceJob[] = [];
  for (const walk of walks) {
    let after = walk.job ? walk.job.after : cursor;
    for (const change of walk.changes) {
      if (stopped || failed.has(vectorRef(change).key)) {
        stopped = true;
        break;
      }
      after = change.seq;
    }
    const finished = !stopped && !walk.full;
    if (walk.job) {
      if (!finished) nextJobs.push({ ...walk.job, after });
    } else {
      cursor = after;
    }
    more ||= !stopped && walk.full;
  }
  const next: ArchivalProgress = {
    cursor,
    sources: state.sources,
    jobs: nextJobs,
  };
  if (
    upserts.length > 0 ||
    deletes.length > 0 ||
    JSON.stringify(next) !== progress.raw
  ) {
    await commitArchival(store, sessionId, progress.raw, guard, {
      state: next,
      upserts,
      deletes,
    });
  }
  return { written: upserts.length, more };
}

/** The archival vector a change addresses. */
function vectorRef(change: RecordChange): { namespace: string; key: string } {
  return { namespace: ARCHIVAL_NAMESPACE, key: archivalVecKey(change) };
}

function commitArchival(
  store: VectorStore,
  sessionId: string,
  expectedValue: string | null,
  guard: IndexGuard,
  batch: {
    readonly state: ArchivalProgress;
    readonly upserts?: VectorIndexUpsert[];
    readonly deletes: { namespace: string; key: string }[];
  },
): Promise<void> {
  return commitIndexBatch(
    store,
    sessionId,
    ARCHIVAL_NS,
    batch.state,
    expectedValue,
    guard,
    { upserts: batch.upserts ?? [], deletes: batch.deletes },
  );
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
  guard: IndexGuard,
  changes: Pick<CommitVectorIndexBatchInput, "upserts" | "deletes">,
): Promise<void> {
  const updated = await store.commitVectorIndexBatch({
    sessionId,
    pluginId: MEMORY_VECTOR_PLUGIN_ID,
    namespace,
    value: JSON.stringify(value),
    expectedValue,
    ...guard,
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
      // The provider transport already retries transient failures; a second
      // loop here would multiply the attempts and retry an abort.
      const vectors = await embed(batch);
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
