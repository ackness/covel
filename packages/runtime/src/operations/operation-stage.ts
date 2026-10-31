/**
 * The operation stage: where write-service calls keep their writes until the
 * caller's commit.
 *
 * A write service changes its provider's own data on behalf of a caller. A
 * successful call stages its writes as one operation. The operation rides on
 * the calling run's result (`RuntimeResult.operations` / `operationWrites`),
 * never among the caller's own proposals, and commits with the caller's
 * commit unit (`commit/finalize-execution.ts`).
 *
 * A **root stage** belongs to one run: a function runtime run, an agent run or
 * a nested `recursiveCall` run. A **child stage** belongs to code inside that
 * run whose success decides whether its operations count: one tool
 * invocation, one sub-agent run. A child commits its operations into its
 * parent when that code succeeds and discards them otherwise, so an operation
 * counts only if every piece of code that asked for it succeeded.
 *
 * Every stage of one root shares a lock per provider: calls of one caller to
 * one provider run one after the other, parallel sub-agents and parallel
 * tool calls included. Each call reads what the calls before it staged for
 * the provider, in call order. A call staged by a child that later fails is
 * taken back for every later reader.
 */

import type {
  DataOpKind,
  OperationRecord,
  Proposal,
  RuntimeResult,
} from "@covel/shared";
import { buildOperationRecord } from "./operation-records.js";

/** The run whose code made a call. */
export interface OperationCaller {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly runId?: string;
}

/** One successful write-service call, as staged. */
export interface StagedOperation {
  readonly id: string;
  /** Call order within the execution. */
  readonly seq: number;
  readonly contract: string;
  readonly providerPluginId: string;
  readonly service: string;
  readonly invokedBy: OperationCaller;
  readonly toolCallId?: string;
  /** The provider's writes, already carrying the provider's identity. */
  readonly writes: readonly Proposal[];
  /** The call's validated input and output. */
  readonly request: unknown;
  readonly result: unknown;
}

/** A provider's declared datasets and their compiled record schemas. */
export interface ProviderDatasets {
  readonly datasets: Readonly<
    Record<
      string,
      { readonly namespace: string; readonly ops: readonly DataOpKind[] }
    >
  >;
  readonly schemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Loads a provider's datasets; `undefined` when the plugin cannot be loaded. */
export type LoadPluginDatasets = (
  pluginId: string,
) => Promise<ProviderDatasets | undefined>;

/**
 * Per-execution state shared by every root stage of the execution, nested
 * executions included: the call sequence and the datasets of the providers
 * that were called.
 */
export interface OperationExecutionScope {
  nextSeq(): number;
  /**
   * Make sure the commit can check a provider's dataset writes. Throws when
   * its datasets cannot be loaded, before the provider's handler runs.
   */
  prepareProvider(pluginId: string): Promise<void>;
  /** The datasets of every provider prepared so far, by plugin id. */
  providerDatasets(): Readonly<Record<string, ProviderDatasets>>;
}

export function createOperationExecutionScope(
  loadPluginDatasets?: LoadPluginDatasets,
): OperationExecutionScope {
  let seq = 0;
  const loaded = new Map<string, Promise<ProviderDatasets>>();
  const settled: Record<string, ProviderDatasets> = {};
  return {
    nextSeq: () => ++seq,
    async prepareProvider(pluginId) {
      if (!loadPluginDatasets) return;
      let pending = loaded.get(pluginId);
      if (!pending) {
        pending = loadPluginDatasets(pluginId).then((datasets) => {
          if (!datasets)
            throw new Error(`the datasets of ${pluginId} cannot be loaded`);
          settled[pluginId] = datasets;
          return datasets;
        });
        loaded.set(pluginId, pending);
        // A failed load is retried by the next call.
        pending.catch(() => {
          if (loaded.get(pluginId) === pending) loaded.delete(pluginId);
        });
      }
      await pending;
    },
    providerDatasets: () => ({ ...settled }),
  };
}

interface Node {
  readonly parent?: Node;
  closed: boolean;
}

interface Entry {
  readonly operation: StagedOperation;
  /** The stage that holds it now; moves up as children commit. */
  owner: Node;
  discarded: boolean;
}

interface Ledger {
  readonly scope: OperationExecutionScope;
  readonly entries: Entry[];
  readonly locks: Map<string, Promise<void>>;
  readonly root: Node;
  attached: boolean;
}

export interface OperationStage {
  /** The run whose code calls through this stage. */
  readonly caller: OperationCaller;
  /** The run whose result carries the operations: the root's caller. */
  readonly owner: OperationCaller;
  readonly sessionId: string;
  readonly turnId: string;
  readonly scope: OperationExecutionScope;
  /**
   * A stage for one tool invocation or sub-agent run inside this one. A
   * sub-agent passes itself as `caller`: its calls are recorded as its own,
   * and its plugin cannot call its own write services either.
   */
  child(caller?: OperationCaller): OperationStage;
  /**
   * Wait until no other call of this root's code to `providerPluginId` is
   * running. Resolves with the release function.
   */
  lock(providerPluginId: string): Promise<() => void>;
  /**
   * The writes of the provider's operations staged so far by this root's
   * code and not taken back, in call order.
   */
  stagedWrites(providerPluginId: string): readonly Proposal[];
  /** Keep one successful call's writes. */
  record(
    operation: Omit<StagedOperation, "id" | "seq" | "invokedBy">,
  ): StagedOperation;
  /** Operations this stage holds now (not those of open children). */
  held(): readonly StagedOperation[];
  /** Child only: hand this stage's operations to its parent. */
  commit(): void;
  /** Take back this stage's operations and those of its open children. */
  discard(): void;
}

function within(node: Node, ancestor: Node): boolean {
  for (let at: Node | undefined = node; at; at = at.parent)
    if (at === ancestor) return true;
  return false;
}

function makeStage(
  ledger: Ledger,
  node: Node,
  identity: Pick<OperationStage, "caller" | "owner" | "sessionId" | "turnId">,
): OperationStage {
  return {
    ...identity,
    scope: ledger.scope,
    child(caller) {
      if (node.closed) throw new Error("This operation stage has ended");
      return makeStage(
        ledger,
        { parent: node, closed: false },
        caller ? { ...identity, caller } : identity,
      );
    },
    async lock(providerPluginId) {
      const previous = ledger.locks.get(providerPluginId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      ledger.locks.set(providerPluginId, tail);
      await previous;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        if (ledger.locks.get(providerPluginId) === tail)
          ledger.locks.delete(providerPluginId);
      };
    },
    stagedWrites(providerPluginId) {
      return ledger.entries
        .filter(
          (entry) =>
            !entry.discarded &&
            entry.operation.providerPluginId === providerPluginId,
        )
        .flatMap((entry) => entry.operation.writes);
    },
    record(operation) {
      if (node.closed || ledger.attached)
        throw new Error("This operation stage has ended");
      const staged: StagedOperation = {
        ...operation,
        id: crypto.randomUUID(),
        seq: ledger.scope.nextSeq(),
        invokedBy: identity.caller,
      };
      ledger.entries.push({ operation: staged, owner: node, discarded: false });
      return staged;
    },
    held() {
      return ledger.entries
        .filter((entry) => !entry.discarded && entry.owner === node)
        .map((entry) => entry.operation);
    },
    commit() {
      if (!node.parent) throw new Error("A root stage does not commit");
      if (node.closed) return;
      node.closed = true;
      for (const entry of ledger.entries)
        if (!entry.discarded && entry.owner === node) entry.owner = node.parent;
    },
    discard() {
      if (node.closed && node.parent) return;
      node.closed = true;
      for (const entry of ledger.entries)
        if (!entry.discarded && within(entry.owner, node))
          entry.discarded = true;
    },
  };
}

export interface RootOperationStage extends OperationStage {
  /**
   * Put the run's operations on its result, once. A run that succeeded
   * keeps the operations its root holds as `staged`, with their writes;
   * everything else is `discarded` without writes. Returns `result`.
   */
  attachTo(result: RuntimeResult, succeeded: boolean): RuntimeResult;
  /** Whether the root holds any operation now. */
  hasOperations(): boolean;
  /** Whether {@link attachTo} already ran. */
  readonly attached: boolean;
}

export function createRootOperationStage(args: {
  readonly caller: OperationCaller;
  readonly sessionId: string;
  readonly turnId: string;
  readonly scope?: OperationExecutionScope;
}): RootOperationStage {
  const root: Node = { closed: false };
  const ledger: Ledger = {
    scope: args.scope ?? createOperationExecutionScope(),
    entries: [],
    locks: new Map(),
    root,
    attached: false,
  };
  const stage = makeStage(ledger, root, {
    caller: args.caller,
    owner: args.caller,
    sessionId: args.sessionId,
    turnId: args.turnId,
  });
  return {
    ...stage,
    get attached() {
      return ledger.attached;
    },
    hasOperations: () =>
      ledger.entries.some((entry) => !entry.discarded && entry.owner === root),
    attachTo(result, succeeded) {
      if (ledger.attached) return result;
      ledger.attached = true;
      root.closed = true;
      if (ledger.entries.length === 0) return result;
      const records: OperationRecord[] = [];
      const writes: Record<string, readonly Proposal[]> = {};
      for (const entry of [...ledger.entries].sort(
        (a, b) => a.operation.seq - b.operation.seq,
      )) {
        const kept = succeeded && !entry.discarded && entry.owner === root;
        if (!kept) entry.discarded = true;
        records.push(
          buildOperationRecord(
            entry.operation,
            kept
              ? { status: "staged" }
              : { status: "discarded", reason: "caller-dropped" },
          ),
        );
        if (kept)
          writes[entry.operation.id] = structuredClone(entry.operation.writes);
      }
      const target = result as {
        operations?: readonly OperationRecord[];
        operationWrites?: Readonly<Record<string, readonly Proposal[]>>;
      };
      target.operations = [...(result.operations ?? []), ...records];
      if (Object.keys(writes).length > 0)
        target.operationWrites = { ...result.operationWrites, ...writes };
      return result;
    },
  };
}

/** Whether a result, or a result nested under it, has staged operation writes. */
export function hasOperationWrites(results: readonly RuntimeResult[]): boolean {
  return results.some(
    (result) => Object.keys(result.operationWrites ?? {}).length > 0,
  );
}
