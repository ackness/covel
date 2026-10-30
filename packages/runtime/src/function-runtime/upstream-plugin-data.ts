/**
 * In-execution visibility of a plugin's own uncommitted plugin-data writes.
 *
 * A runtime reads its plugin's data as the store holds it, with the writes of
 * completed upstream runtimes of the SAME plugin in this execution applied in
 * commit order, then its own buffered writes. Only writes that would commit
 * are visible: the eligibility rule and the effects normalization are the
 * commit's own functions, and results are walked with the commit's order
 * (`inCommitOrder`, nested children before their parent).
 *
 * Not visible: other plugins' writes, siblings of the same DAG level (the set
 * is taken when the runtime starts, and `completedResults` changes only
 * between levels), retry and detached seeds (their source execution already
 * committed or dropped them; re-applying an operation list would count it
 * twice), and a parent execution's upstream inside a nested execution.
 *
 * Upstream writes are read-only context. They never enter the reader's write
 * buffer or pending proposals, which would commit them a second time.
 *
 * Each read records which upstream producers' writes it actually saw
 * (`read-dependencies.ts`): finalize drops an auxiliary reader whose producer
 * was dropped.
 */

import {
  applyDataOps,
  isHiddenPluginDataNamespace,
  type DataOpsCurrent,
  type JsonValue,
  type Proposal,
  type RuntimeResult,
} from "@covel/shared";
import type { PluginServiceContext } from "@covel/shared/plugin-runtime";
import type { DataStore } from "@covel/store";
import { overlayPluginDataValue } from "@covel/tools";
import { mergePluginDataRows } from "./execution-write-buffer.js";
import { inCommitOrder } from "../turn-executor/nested-results.js";
import { commitEligibility } from "../session/session-runtime-result.js";
import {
  malformedDomainEffect,
  pluginDataProposalsFromEffects,
} from "../commit/session-output-normalizer.js";
import { createReadRecorder, type ReadRecorder } from "../read-dependencies.js";

/** One plugin-data proposal of an upstream result, as it would commit. */
export interface UpstreamPluginDataWrite {
  /** The producing result's `runId`: the producer id of a read dependency. */
  readonly runId: string;
  readonly runtimeId: string;
  readonly proposal: Proposal;
}

const PLUGIN_DATA_PROPOSALS: ReadonlySet<Proposal["type"]> = new Set([
  "plugin.data",
  "plugin.data.batch",
  "plugin.data.delete",
  "plugin.data.update",
]);

/** The plugin-data proposals one result would commit, in commit order. */
function committedPluginData(
  result: RuntimeResult,
  sessionId: string,
): Proposal[] {
  const eligibility = commitEligibility(result);
  if (eligibility === "none" || malformedDomainEffect(result.effects))
    return [];
  const source = { pluginId: result.pluginId, runtimeId: result.runtimeId };
  // `collectRuntimeProposals` order: effects-derived writes, then buffered.
  return [
    ...(eligibility === "all"
      ? pluginDataProposalsFromEffects(
          result.effects,
          source,
          result.turnId,
          sessionId,
        )
      : []),
    ...(result.pendingProposals ?? []),
  ]
    .filter((proposal) => PLUGIN_DATA_PROPOSALS.has(proposal.type))
    .map(
      (proposal) =>
        // Rebind identity as the commit does; plugin code could forge it.
        ({ ...proposal, sessionId, turnId: result.turnId, source }) as Proposal,
    );
}

/**
 * The plugin-data writes of `pluginId` that the completed, commit-eligible
 * results would commit, in commit order. `seeds` are results seeded from
 * another execution; they and everything nested under them are skipped.
 * Returns an owned copy.
 */
export function collectUpstreamPluginDataWrites(
  results: ReadonlyMap<string, RuntimeResult>,
  sessionId: string,
  pluginId: string,
  seeds?: ReadonlySet<RuntimeResult>,
): readonly UpstreamPluginDataWrite[] {
  const own = [...results.values()].filter((result) => !seeds?.has(result));
  return structuredClone(
    inCommitOrder(own).flatMap((result) =>
      result.pluginId === pluginId
        ? committedPluginData(result, sessionId).map((proposal) => ({
            runId: result.runId,
            runtimeId: result.runtimeId,
            proposal,
          }))
        : [],
    ),
  );
}

/** One overlay read, reported to `TurnExecutorDeps.pluginDataReadProbe`. */
export interface PluginDataReadObservation {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly runId: string | undefined;
  readonly kind: "get" | "list";
  readonly namespace?: string;
  readonly key?: string;
  /** What the read returns from the store and the reader's own buffer only. */
  readonly withoutUpstream: unknown;
  /** What the read returns. */
  readonly visible: unknown;
  /** Upstream producer ids the read depends on. */
  readonly producers: readonly string[];
}

export type PluginDataReadProbe = (read: PluginDataReadObservation) => void;

/** One invocation's upstream writes and the dependencies its reads record. */
export interface PluginDataVisibility {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly runId: string | undefined;
  readonly writes: readonly UpstreamPluginDataWrite[];
  /** Kernel-only snapshot of another provider's upstream writes. */
  readonly upstreamOf?: (
    pluginId: string,
  ) => readonly UpstreamPluginDataWrite[];
  /** Shared by every read of the invocation: handler, store, tools. */
  readonly recorder: ReadRecorder;
  readonly probe?: PluginDataReadProbe;
}

/** A fresh visibility, with its own recorder, for one invocation. */
export function createPluginDataVisibility(options: {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly runId?: string;
  readonly writes?: readonly UpstreamPluginDataWrite[];
  readonly upstreamOf?: PluginDataVisibility["upstreamOf"];
  readonly probe?: PluginDataReadProbe;
}): PluginDataVisibility {
  return {
    pluginId: options.pluginId,
    runtimeId: options.runtimeId,
    runId: options.runId,
    writes: options.writes ?? [],
    ...(options.upstreamOf ? { upstreamOf: options.upstreamOf } : {}),
    recorder: createReadRecorder(),
    ...(options.probe ? { probe: options.probe } : {}),
  };
}

/** A service reads its provider's data but records on the calling invocation. */
export function readProviderData(options: {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly signal: AbortSignal;
  readonly store?: Pick<DataStore, "getPluginData" | "listPluginData">;
  readonly visibility?: PluginDataVisibility;
  readonly writeBuffer?: readonly Proposal[];
}): PluginServiceContext["pluginData"] {
  const { sessionId, pluginId, signal, store, visibility } = options;
  const provider = visibility
    ? { ...visibility, writes: visibility.upstreamOf?.(pluginId) ?? [] }
    : undefined;
  // The read scope survives nested calls; the immediate service caller is
  // not necessarily the runtime that owns this buffer.
  const buffer =
    visibility?.pluginId === pluginId ? (options.writeBuffer ?? []) : [];
  return {
    async get(namespace, key) {
      signal.throwIfAborted();
      if (isHiddenPluginDataNamespace(namespace)) return null;
      const row = await store?.getPluginData(
        sessionId,
        pluginId,
        namespace,
        key,
      );
      signal.throwIfAborted();
      const base: DataOpsCurrent = row
        ? { exists: true, value: row.value as JsonValue }
        : { exists: false };
      const { current, producers } = readPluginDataKey(
        provider,
        buffer,
        pluginId,
        namespace,
        key,
        base,
      );
      const visible = current.exists ? current.value : null;
      noteRead(provider, {
        kind: "get",
        namespace,
        key,
        visible,
        producers,
        withoutUpstream: () => {
          const own = readPluginDataKey(
            undefined,
            buffer,
            pluginId,
            namespace,
            key,
            base,
          );
          return own.current.exists ? own.current.value : null;
        },
      });
      return structuredClone(visible);
    },
    async list(namespace) {
      signal.throwIfAborted();
      if (isHiddenPluginDataNamespace(namespace)) return [];
      const rows =
        (await store?.listPluginData(sessionId, pluginId, namespace)) ?? [];
      signal.throwIfAborted();
      const merged = mergePluginDataRows(
        rows,
        buffer,
        sessionId,
        pluginId,
        namespace,
        provider?.writes,
      );
      noteRead(provider, {
        kind: "list",
        namespace,
        visible: observedRows(merged),
        producers: listPluginDataProducers(provider, namespace),
        withoutUpstream: () =>
          observedRows(
            mergePluginDataRows(rows, buffer, sessionId, pluginId, namespace),
          ),
      });
      return structuredClone(merged.map(({ key, value }) => ({ key, value })));
    },
  };
}

/**
 * Project upstream writes and the buffer onto one key, and find the upstream
 * producers whose writes still shape the result. A whole-value write (`set`,
 * `delete`, or an operation list that contains either) replaces what came
 * before it, so a later one of the reader's own leaves no dependency. An
 * operation list that fails is skipped, as the commit rejects it, and is not
 * read. The value equals `overlayPluginDataValue` over the same list.
 */
export function readPluginDataKey(
  visibility: PluginDataVisibility | undefined,
  buffer: readonly Proposal[],
  pluginId: string,
  namespace: string,
  key: string,
  base: DataOpsCurrent,
): {
  readonly hit: boolean;
  readonly current: DataOpsCurrent;
  readonly producers: readonly string[];
} {
  let state = base;
  let hit = false;
  const producers = new Set<string>();
  const apply = (proposal: Proposal, producer: string | undefined) => {
    const next = overlayPluginDataValue(
      [proposal],
      pluginId,
      namespace,
      key,
      state,
    );
    if (!next.hit) return;
    hit = true;
    if (proposal.type === "plugin.data.update") {
      const { ops } = proposal.payload;
      if (!applyDataOps(state, ops).ok) return;
      // Any `set` or `delete` in a list that applied replaces the whole
      // value, so what the list keeps of earlier writes ends there.
      if (ops.some((op) => op.op === "set" || op.op === "delete"))
        producers.clear();
    } else {
      producers.clear();
    }
    if (producer !== undefined) producers.add(producer);
    state = next.exists
      ? { exists: true, value: next.value }
      : { exists: false };
  };
  for (const write of visibility?.writes ?? [])
    apply(write.proposal, write.runId);
  for (const proposal of buffer) apply(proposal, undefined);
  return { hit, current: state, producers: [...producers] };
}

function writtenNamespaces(proposal: Proposal): readonly string[] {
  switch (proposal.type) {
    case "plugin.data":
    case "plugin.data.delete":
    case "plugin.data.update":
      return [proposal.payload.namespace];
    case "plugin.data.batch":
      return (proposal.payload.items ?? []).map((item) => item.namespace);
    default:
      return [];
  }
}

/**
 * Upstream producers a list of `namespace` depends on: every one that wrote
 * any key in it, or any plugin data at all without a namespace. Conservative:
 * a list's result depends on keys the reader may never look at.
 */
export function listPluginDataProducers(
  visibility: PluginDataVisibility | undefined,
  namespace: string | undefined,
): readonly string[] {
  const producers = new Set<string>();
  for (const write of visibility?.writes ?? []) {
    if (
      writtenNamespaces(write.proposal).some(
        (written) => namespace === undefined || written === namespace,
      )
    )
      producers.add(write.runId);
  }
  return [...producers];
}

/**
 * What a probe sees of a list: namespace, key and value, sorted. Stored
 * timestamps describe persistence, not the values this execution depends on.
 */
export function observedRows(
  rows: readonly {
    readonly namespace?: string;
    readonly key: string;
    readonly value: unknown;
  }[],
): {
  readonly namespace?: string;
  readonly key: string;
  readonly value: unknown;
}[] {
  return rows
    .map((row) => ({
      ...(row.namespace !== undefined ? { namespace: row.namespace } : {}),
      key: row.key,
      value: row.value,
    }))
    .sort((a, b) =>
      JSON.stringify([a.namespace ?? "", a.key]) <
      JSON.stringify([b.namespace ?? "", b.key])
        ? -1
        : 1,
    );
}

/**
 * Record a read's dependencies and report it to the probe. The value without upstream writes
 * is computed only for a probe. A probe that throws never affects the read.
 */
export function noteRead(
  visibility: PluginDataVisibility | undefined,
  read: {
    readonly kind: "get" | "list";
    readonly namespace?: string;
    readonly key?: string;
    readonly visible: unknown;
    readonly withoutUpstream: () => unknown;
    readonly producers: readonly string[];
  },
): void {
  if (!visibility) return;
  for (const producer of read.producers) visibility.recorder.add(producer);
  const probe = visibility.probe;
  if (!probe) return;
  try {
    probe({
      pluginId: visibility.pluginId,
      runtimeId: visibility.runtimeId,
      runId: visibility.runId,
      kind: read.kind,
      ...(read.namespace !== undefined ? { namespace: read.namespace } : {}),
      ...(read.key !== undefined ? { key: read.key } : {}),
      withoutUpstream: read.withoutUpstream(),
      visible: read.visible,
      producers: read.producers,
    });
  } catch (error) {
    console.warn(
      `[plugin-data] read probe failed for ${visibility.runtimeId}:`,
      error,
    );
  }
}
