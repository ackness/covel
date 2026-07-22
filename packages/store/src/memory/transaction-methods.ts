import type { StoreTransaction } from "../types.js";
import { SESSION_SCOPED_TABLES } from "../table-registry.js";
import type { MemoryCollectionKind } from "../table-registry.js";
import {
  nestedWithTransactionError,
  SERIALIZED_NESTING_REASON,
} from "../tx-nesting-error.js";
import type { SerializedWriteGate } from "../serialized-write-gate.js";
import {
  replaceArrayContents,
  replaceMapContents,
} from "./collection-helpers.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

/**
 * The MemoryState collections a transaction snapshot may capture.
 *
 * Derived from {@link SESSION_SCOPED_TABLES} (so a newly-registered session
 * table is snapshottable automatically) plus the parent `sessions` map and the
 * non-session-scoped mutable collections (`worlds`, `vectorRows`) a transaction
 * may also touch. `tests/table-registry-consistency.test.ts` pins this list
 * against the registry.
 */
export const MEMORY_SNAPSHOT_COLLECTIONS: ReadonlyArray<{
  readonly key: keyof MemoryState;
  readonly kind: MemoryCollectionKind;
}> = [
  { key: "sessions", kind: "map" },
  ...SESSION_SCOPED_TABLES.map((t) => ({
    key: t.memoryKey as keyof MemoryState,
    kind: t.memoryKind,
  })),
  // Non-session-scoped mutable collections a transaction may also write.
  { key: "worlds", kind: "map" },
  { key: "vectorRows", kind: "map" },
];

const SNAPSHOT_KIND_BY_KEY: ReadonlyMap<
  keyof MemoryState,
  MemoryCollectionKind
> = new Map(MEMORY_SNAPSHOT_COLLECTIONS.map((c) => [c.key, c.kind]));

const ALL_SNAPSHOT_KEYS: readonly (keyof MemoryState)[] =
  MEMORY_SNAPSHOT_COLLECTIONS.map((c) => c.key);

type Touched = readonly (keyof MemoryState)[];

/**
 * Which snapshot collections each mutating StoreTransaction method touches.
 *
 * Drives touched-only snapshotting (audit 2026-07-11 R-16): a transaction
 * captures a shallow copy of a collection lazily, the first time a method
 * that writes it is invoked — instead of eagerly copying every collection per
 * transaction. Methods mapped to `[]` mutate only state that was never part
 * of the snapshot (vector model registry / session vector targets), preserving
 * pre-existing rollback semantics for them.
 *
 * Safety net: a mutating method missing from this map (and not matching a
 * read prefix) falls back to capturing ALL collections — new write methods
 * degrade to the old eager behaviour instead of silently breaking rollback.
 * `tests/memory-transaction-rollback.test.ts` pins that every key here names a
 * real store method.
 */
export const WRITE_METHOD_TOUCHES: Readonly<Record<string, Touched>> = {
  // sessions
  createSession: ["sessions"],
  updateSession: ["sessions"],
  deleteSession: ALL_SNAPSHOT_KEYS, // cascades across every session-scoped collection
  // runtime records
  saveTurnResult: ["turnResults"],
  setTurnResultCommitStatus: ["turnResults"],
  saveRuntimeResult: ["runtimeResults"],
  saveToolCall: ["toolCalls"],
  saveStateSchema: ["stateSchemas"],
  deleteStateSchema: ["stateSchemas"],
  upsertStateEntry: ["stateEntries"],
  addStateChange: ["stateChanges"],
  saveEvent: ["events"],
  saveApproval: ["approvals"],
  addMessage: ["messages"],
  upsertCharacter: ["characters"],
  deleteCharacter: ["characters"],
  addTraceEvent: ["traceEvents"],
  saveRuntimeOutput: ["runtimeOutputs"],
  saveInteractionRecord: ["interactionRecords"],
  appendTurnMessage: ["turnMessages"],
  tagTurnMessagesCompacted: ["turnMessages"],
  savePlayerInput: ["playerInputs"],
  saveSessionSummary: ["sessionSummaries"],
  deleteSessionSummaries: ["sessionSummaries"],
  // plugin data
  setPluginData: ["pluginData"],
  setPluginDataBatch: ["pluginData"],
  deletePluginData: ["pluginData"],
  // working memory / ledger / lorebook
  upsertWorkingMemory: ["workingMemoryEntries"],
  deleteWorkingMemory: ["workingMemoryEntries"],
  saveWorldDataImportLedgerBatch: ["worldDataImportLedger"],
  deleteWorldDataImportLedger: ["worldDataImportLedger"],
  upsertLorebookEntries: ["lorebookEntries"],
  deleteLorebookEntry: ["lorebookEntries"],
  // suspensions + snapshots
  saveSuspension: ["suspensions"],
  claimSuspension: ["suspensions"],
  markSuspensionResolved: ["suspensions"],
  deleteSuspension: ["suspensions"],
  deleteExpiredSuspensions: ["suspensions"],
  saveSnapshot: ["snapshots"],
  // scheduling-redesign lifecycle records
  insertLogicalTurnCompletion: ["logicalTurnLedger"],
  insertSetupAttempt: ["setupAttempts"],
  updateSetupAttempt: ["setupAttempts"],
  appendJobStatus: ["jobStatus"],
  // worlds + vectors
  upsertWorld: ["worlds"],
  deleteWorld: ["worlds"],
  upsertVector: ["vectorRows"],
  deleteVectors: ["vectorRows"],
  // Mutate only never-snapshotted state (vector model registry / targets) —
  // parity with the previous eager snapshot, which excluded them too.
  ensureVectorModel: [],
  lockSessionEmbeddingModel: [],
  resolveSessionVectorTarget: [],
};

/** Method-name prefixes that never mutate MemoryState. */
const READ_METHOD_PREFIXES = ["get", "list", "search"] as const;

function isReadMethod(name: string): boolean {
  return READ_METHOD_PREFIXES.some((p) => name.startsWith(p));
}

/** A captured snapshot: collection key → shallow copy of its contents. */
type MemorySnapshot = Map<keyof MemoryState, unknown>;

/**
 * Lazily capture a shallow copy of one collection into the snapshot.
 *
 * Performance (audit 2026-06-04 finding H3 + 2026-07-11 R-16): instead of
 * `structuredClone`-ing (or even shallow-copying) every collection per
 * transaction, we shallow-copy each collection at most once, and only when a
 * method that writes it runs — a fresh `Map`/array holding the same record
 * references.
 *
 * Correctness invariant this relies on: MemoryStore methods never mutate a
 * stored record object in place. Every write path either pushes a new object,
 * `.set(key, newObject)`, replaces an array slot with a spread copy
 * (`arr[i] = { ...arr[i], ... }`), or `.delete()`s. A `Map`/array shallow copy
 * therefore preserves the exact membership at capture time, and
 * `restoreSnapshot` rewinds structure (insertions, deletions, slot
 * replacements) faithfully — the shared record references it restores were
 * never mutated, so isolation and rollback semantics are unchanged.
 *
 * If a future method mutates a stored record in place, that invariant breaks
 * for both this shallow snapshot *and* any reference-sharing reader — the fix
 * is to keep replacing whole records, not to reintroduce a blanket deep clone.
 */
function captureCollection(
  state: MemoryState,
  snapshot: MemorySnapshot,
  key: keyof MemoryState,
): void {
  if (snapshot.has(key)) return;
  const kind = SNAPSHOT_KIND_BY_KEY.get(key);
  if (!kind) return;
  const value = state[key];
  snapshot.set(
    key,
    kind === "map"
      ? new Map(value as Map<unknown, unknown>)
      : [...(value as readonly unknown[])],
  );
}

function restoreSnapshot(state: MemoryState, snapshot: MemorySnapshot): void {
  for (const [key, saved] of snapshot) {
    if (SNAPSHOT_KIND_BY_KEY.get(key) === "map") {
      replaceMapContents(
        state[key] as unknown as Map<unknown, unknown>,
        saved as Map<unknown, unknown>,
      );
    } else {
      replaceArrayContents(
        state[key] as unknown as unknown[],
        saved as unknown[],
      );
    }
  }
}

/**
 * Wrap the transaction scope so every write method captures the collections
 * it touches before mutating them. Read methods pass through untouched.
 */
function makeTrackingScope(
  base: StoreTransaction,
  onTouch: (methodName: string) => void,
): StoreTransaction {
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") {
        return value;
      }
      if (isReadMethod(prop)) return value;
      return (...args: unknown[]) => {
        onTouch(prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export function createTransactionMethods(
  state: MemoryState,
  getScope: () => StoreTransaction,
  gate: SerializedWriteGate,
): MemoryStoreMethods {
  // Transactions are serialized so two concurrent ones snapshot / restore
  // against a stable state rather than interleaving on shared Maps. Writes
  // issued from outside a transaction share the same queue (see
  // ../serialized-write-gate.ts), so a write from another session can no
  // longer be captured by — and rolled back with — this transaction's
  // snapshot. Nesting would queue the inner call behind the outer one and
  // deadlock, so it is rejected synchronously via the AsyncLocalStorage guard.
  return {
    async withTransaction<T>(
      fn: (tx: StoreTransaction) => Promise<T>,
    ): Promise<T> {
      // Synchronous nesting guard — checked at CALL time (before chaining), so a
      // nested call rejects instead of deadlocking behind the outer transaction.
      if (gate.isInTransaction()) {
        throw nestedWithTransactionError(
          "MemoryStore",
          "memory",
          SERIALIZED_NESTING_REASON,
        );
      }
      return gate.runExclusive(async () => {
        const snap: MemorySnapshot = new Map();
        const scope = makeTrackingScope(getScope(), (methodName) => {
          // Unknown mutating method → capture everything (safe fallback,
          // equivalent to the pre-touched-only eager snapshot).
          const touched = WRITE_METHOD_TOUCHES[methodName] ?? ALL_SNAPSHOT_KEYS;
          for (const key of touched) captureCollection(state, snap, key);
        });
        try {
          // Resolve on success = commit (discard snapshot).
          return await fn(scope);
        } catch (err) {
          restoreSnapshot(state, snap);
          throw err;
        }
      });
    },
  };
}
