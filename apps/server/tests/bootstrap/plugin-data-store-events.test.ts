import { describe, expect, it, vi } from "vitest";
import type { EventBus } from "@covel/events";
import type { DataStore, PluginDataRecord, SessionRecord } from "@covel/store";
import { createSqliteStore } from "@covel/store";
import { createCommitPipeline } from "@covel/runtime";
import type { Proposal } from "@covel/shared";
import { wrapStoreWithPluginDataEvents } from "../../src/routes/api/bootstrap/plugin-data-store-events.js";

function makeRecord(): PluginDataRecord {
  const now = new Date().toISOString();
  return {
    id: "r1",
    sessionId: "s1",
    pluginId: "scene-prompts",
    namespace: "message",
    key: "prompt1Text",
    value: "look around",
    createdAt: now,
    updatedAt: now,
  };
}

function pluginDataChangedEmits(emit: ReturnType<typeof vi.fn>): unknown[] {
  return emit.mock.calls
    .map(([m]) => m as { payload?: { _subType?: string } })
    .filter((m) => m.payload?._subType === "plugin-data.changed");
}

describe("wrapStoreWithPluginDataEvents", () => {
  it("emits plugin-data.changed for writes made through the transaction view", async () => {
    const emit = vi.fn();
    const eventBus = { emit } as unknown as EventBus;

    // A store whose commit-style writes go through the tx view (SQLite/PG shape).
    // The tx write must still surface plugin-data.changed, or the live UI never
    // refreshes until a page reload.
    const tx = {
      setPluginDataBatch: vi.fn(async () => {}),
    };
    const store = {
      withTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
    } as unknown as DataStore;

    const wrapped = wrapStoreWithPluginDataEvents(store, eventBus);

    await wrapped.withTransaction!(async (t) => {
      await (t as unknown as typeof tx).setPluginDataBatch([makeRecord()]);
    });

    expect(tx.setPluginDataBatch).toHaveBeenCalledOnce();
    const emitted = pluginDataChangedEmits(emit);
    expect(emitted).toHaveLength(1);
  });

  it("buffers tx-scoped events until commit and flushes them in write order", async () => {
    const emit = vi.fn();
    const eventBus = { emit } as unknown as EventBus;

    const tx = { setPluginData: vi.fn(async () => {}) };
    // Capture how many events reached the real bus at the COMMIT boundary (just
    // before withTransaction returns). Buffering means it must be zero there.
    let emitsAtCommit = -1;
    const store = {
      withTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
        const r = await fn(tx);
        emitsAtCommit = pluginDataChangedEmits(emit).length;
        return r;
      }),
    } as unknown as DataStore;

    const wrapped = wrapStoreWithPluginDataEvents(store, eventBus);
    await wrapped.withTransaction!(async (t) => {
      const view = t as unknown as typeof tx;
      await view.setPluginData({ ...makeRecord(), key: "a", value: "1" });
      await view.setPluginData({ ...makeRecord(), key: "b", value: "2" });
    });

    expect(emitsAtCommit).toBe(0); // nothing broadcast/persisted before COMMIT
    const emitted = pluginDataChangedEmits(emit) as Array<{
      payload?: { changes?: Array<{ key?: string }> };
    }>;
    expect(emitted).toHaveLength(2);
    expect(emitted.map((e) => e.payload?.changes?.[0]?.key)).toEqual([
      "a",
      "b",
    ]);
  });

  it("discards buffered events when the transaction rolls back", async () => {
    const emit = vi.fn();
    const eventBus = { emit } as unknown as EventBus;

    const tx = { setPluginData: vi.fn(async () => {}) };
    // Real stores rethrow after rollback; a mid-chain proposal error is the
    // common trigger. The successful earlier write must not leave a phantom.
    const store = {
      withTransaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
    } as unknown as DataStore;

    const wrapped = wrapStoreWithPluginDataEvents(store, eventBus);
    await expect(
      wrapped.withTransaction!(async (t) => {
        await (t as unknown as typeof tx).setPluginData(makeRecord());
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(pluginDataChangedEmits(emit)).toHaveLength(0);
  });

  it("still emits for direct (non-transactional) writes", async () => {
    const emit = vi.fn();
    const eventBus = { emit } as unknown as EventBus;
    const store = {
      setPluginDataBatch: vi.fn(async () => {}),
    } as unknown as DataStore;

    const wrapped = wrapStoreWithPluginDataEvents(store, eventBus);
    await wrapped.setPluginDataBatch([makeRecord()]);

    expect(pluginDataChangedEmits(emit)).toHaveLength(1);
  });
});

// End-to-end proof against the REAL SQLite store + commit pipeline: this is the
// exact path scene-prompts uses in production (plugin.data.batch proposal →
// commitAll → SqliteStore.withTransaction → tx write). Before the fix this
// committed the data but emitted nothing, so the live message-block surface
// never refreshed until a page reload re-read the DB.
describe("wrapStoreWithPluginDataEvents · real SQLite commit pipeline", () => {
  it("emits plugin-data.changed when a plugin.data.batch proposal commits", async () => {
    const emit = vi.fn();
    const eventBus = { emit } as unknown as EventBus;
    const base = createSqliteStore(":memory:");
    const sessionId = "s-tx-1";
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: sessionId,
      worldId: "tx-test",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      locale: "en",
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    };
    await base.createSession(session);

    const store = wrapStoreWithPluginDataEvents(base, eventBus);
    // The pipeline commits through store.withTransaction (SQLite has it), so the
    // handler writes via the tx view — the path the fix re-wraps.
    const pipeline = createCommitPipeline(store);

    const proposal: Proposal = {
      id: "p-tx-1",
      type: "plugin.data.batch",
      source: { pluginId: "scene-prompts", runtimeId: "scene-prompts" },
      turnId: "turn-tx",
      sessionId,
      payload: {
        items: [
          { namespace: "message", key: "__turnId", value: "turn-tx" },
          { namespace: "message", key: "prompt1Text", value: "look around" },
        ],
      },
      timestamp: now,
    };

    const [result] = await pipeline.commitAll([proposal]);
    expect(result.committed).toBe(true);

    const emitted = pluginDataChangedEmits(emit) as Array<{
      payload?: { pluginId?: string };
    }>;
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload?.pluginId).toBe("scene-prompts");

    // Data really landed (rules out a phantom event on an empty write).
    const rows = await base.listPluginData(
      sessionId,
      "scene-prompts",
      "message",
    );
    expect(rows).toHaveLength(2);

    await base.close?.();
  });
});
