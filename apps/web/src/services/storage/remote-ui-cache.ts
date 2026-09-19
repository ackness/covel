import { z } from "zod";
import {
  REMOTE_UI_CACHE_STORE,
  REMOTE_UI_CACHE_EPOCHS,
} from "@covel/store/idb-schema";
import { openBrowserCacheDb } from "./cache-db.js";

export interface RemoteUiOwner {
  readonly sessionId: string;
  readonly worldId: string;
  readonly incarnation: string;
}
export type RemoteUiScope = {
  readonly kind: "session" | "world";
  readonly id: string;
};
export interface RemoteUiStamp {
  readonly epochs: readonly string[];
  readonly cachedIncarnation: string | undefined;
  readonly cachedWorldId: string | undefined;
}

const recordSchema = z.object({
  sessionId: z.string(),
  worldId: z.string(),
  incarnation: z.string(),
  submitted: z.object({
    ids: z.array(z.string()),
    values: z.record(z.string(), z.record(z.string(), z.unknown())),
  }),
  steps: z.array(z.unknown()),
});
type RemoteUiRecord = z.infer<typeof recordSchema>;

export class RemoteUiCacheChangedError extends Error {
  constructor() {
    super("Remote session cache ownership changed during the operation");
    this.name = "RemoteUiCacheChangedError";
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The callback awaits only IDB requests, keeping the transaction active. */
async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openBrowserCacheDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    let failure: unknown;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () =>
      reject(
        failure ?? tx.error ?? new Error("Remote UI cache transaction aborted"),
      );
    void run(tx).then(
      (result) => {
        value = result;
      },
      (error: unknown) => {
        failure = error;
        try {
          tx.abort();
        } catch {
          reject(error);
        }
      },
    );
  });
}

const scopeKey = (scope: RemoteUiScope) => `${scope.kind}:${scope.id}`;
const ownerKeys = (owner: RemoteUiOwner) => [
  scopeKey({ kind: "session", id: owner.sessionId }),
  scopeKey({ kind: "world", id: owner.worldId }),
];
function parseRecord(raw: unknown): RemoteUiRecord | undefined {
  const result = recordSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** Capture before the authoritative server read. Every captured epoch exists. */
export function captureRemoteUiStamp(
  owner: RemoteUiOwner,
): Promise<RemoteUiStamp> {
  return transaction(
    [REMOTE_UI_CACHE_STORE, REMOTE_UI_CACHE_EPOCHS],
    "readwrite",
    async (tx) => {
      const epochsStore = tx.objectStore(REMOTE_UI_CACHE_EPOCHS);
      const epochs = await Promise.all(
        ownerKeys(owner).map(async (key) => {
          const current: unknown = await request(epochsStore.get(key));
          if (typeof current === "string" && current) return current;
          const epoch = crypto.randomUUID();
          await request(epochsStore.put(epoch, key));
          return epoch;
        }),
      );
      const record = parseRecord(
        await request(
          tx.objectStore(REMOTE_UI_CACHE_STORE).get(owner.sessionId),
        ),
      );
      return {
        epochs,
        cachedIncarnation: record?.incarnation,
        cachedWorldId: record?.worldId,
      };
    },
  );
}

/** Merge or read only after the same owner was verified against the server. */
export function useRemoteUiCache(
  owner: RemoteUiOwner,
  stamp: RemoteUiStamp,
  update?:
    | {
        readonly kind: "submitted";
        readonly ids: string[];
        readonly values: Record<string, Record<string, unknown>>;
      }
    | { readonly kind: "steps"; readonly steps: unknown[] },
): Promise<RemoteUiRecord> {
  const owned = structuredClone(update);
  return transaction(
    [REMOTE_UI_CACHE_STORE, REMOTE_UI_CACHE_EPOCHS],
    "readwrite",
    async (tx) => {
      const epochsStore = tx.objectStore(REMOTE_UI_CACHE_EPOCHS);
      const epochs = await Promise.all(
        ownerKeys(owner).map((key) => request(epochsStore.get(key))),
      );
      if (epochs.some((epoch, index) => epoch !== stamp.epochs[index]))
        throw new RemoteUiCacheChangedError();
      const records = tx.objectStore(REMOTE_UI_CACHE_STORE);
      const current = parseRecord(await request(records.get(owner.sessionId)));
      const ownsCurrent =
        current?.incarnation === owner.incarnation &&
        current.worldId === owner.worldId;
      const bindingUnchanged =
        current?.incarnation === stamp.cachedIncarnation &&
        current?.worldId === stamp.cachedWorldId;
      if (!ownsCurrent && !bindingUnchanged) {
        throw new RemoteUiCacheChangedError();
      }
      const record: RemoteUiRecord =
        current?.incarnation === owner.incarnation
          ? current
          : { ...owner, submitted: { ids: [], values: {} }, steps: [] };
      if (owned?.kind === "submitted") {
        record.submitted = {
          ids: [...new Set([...record.submitted.ids, ...owned.ids])],
          values: { ...record.submitted.values, ...owned.values },
        };
      } else if (owned?.kind === "steps") record.steps = owned.steps;
      // Bind even empty reads so an older response cannot replace a new incarnation.
      record.worldId = owner.worldId;
      await request(records.put(record));
      return record;
    },
  );
}

/** Removing an epoch invalidates outstanding stamps without permanent tombstones. */
export function invalidateRemoteUiScope(scope: RemoteUiScope): Promise<void> {
  return transaction([REMOTE_UI_CACHE_EPOCHS], "readwrite", async (tx) => {
    await request(
      tx.objectStore(REMOTE_UI_CACHE_EPOCHS).delete(scopeKey(scope)),
    );
  });
}

export function listRemoteUiOwners(
  scope: RemoteUiScope,
): Promise<RemoteUiOwner[]> {
  return transaction([REMOTE_UI_CACHE_STORE], "readonly", async (tx) => {
    const records = tx.objectStore(REMOTE_UI_CACHE_STORE);
    const raw: unknown[] =
      scope.kind === "world"
        ? await request(records.index("worldId").getAll(scope.id))
        : [await request(records.get(scope.id))];
    return raw.flatMap((value) => {
      const record = parseRecord(value);
      return record
        ? [
            {
              sessionId: record.sessionId,
              worldId: record.worldId,
              incarnation: record.incarnation,
            },
          ]
        : [];
    });
  });
}

/** Never remove a same-id replacement that was admitted after the stale read. */
export function discardRemoteUiOwner(owner: RemoteUiOwner): Promise<void> {
  return transaction(
    [REMOTE_UI_CACHE_STORE, REMOTE_UI_CACHE_EPOCHS],
    "readwrite",
    async (tx) => {
      const records = tx.objectStore(REMOTE_UI_CACHE_STORE);
      const current = parseRecord(await request(records.get(owner.sessionId)));
      if (
        current &&
        (current.incarnation !== owner.incarnation ||
          current.worldId !== owner.worldId)
      )
        return;
      await request(records.delete(owner.sessionId));
      await request(
        tx
          .objectStore(REMOTE_UI_CACHE_EPOCHS)
          .delete(scopeKey({ kind: "session", id: owner.sessionId })),
      );
    },
  );
}
