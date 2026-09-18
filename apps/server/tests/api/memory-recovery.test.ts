import { describe, expect, it, vi } from "vitest";
import { createMemorySystem, type MemoryLLMAdapter } from "@covel/memory";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store/contracts";
import { commitExecution, type CommitExecutionArgs } from "@covel/runtime";
import { createMemoryRecovery } from "../../src/routes/api/bootstrap/memory-recovery.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

const now = "2026-09-18T00:00:00Z";
const core = {
  blocks: [
    {
      label: "story_state",
      displayName: "Story",
      extractionHint: "Record what happened.",
    },
  ],
};
async function fixture() {
  const store = createMemoryStore();
  await store.createSession({
    id: "s",
    worldId: "w",
    presetId: "default",
    locale: "en",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: ["story"],
    createdAt: now,
    updatedAt: now,
  });
  return store;
}
function boot(
  store: DataStore,
  llm: MemoryLLMAdapter,
  lock = createInProcessSessionLock(),
) {
  const recovery = createMemoryRecovery(store, core, (id, task) =>
    lock.withLock(id, task),
  );
  const system = createMemorySystem(
    { store, llm },
    { coreMemory: core, updater: { commitUpdate: recovery.commitUpdate } },
  );
  return {
    ...system,
    updater: recovery.wrap(system.updater, system.manager, llm, () => "plugin"),
  };
}
async function leavePending(store: DataStore, fail = false) {
  const memory = boot(store, {
    complete: vi
      .fn()
      .mockRejectedValue(new Error("must not run before recovery")),
  });
  const args: CommitExecutionArgs = {
    store,
    sessionId: "s",
    turnIds: [],
    runtimes: [{ name: "story", pluginId: "story", outputKind: "story" }],
    results: [
      {
        runtimeId: "story",
        pluginId: "story",
        turnId: "turn",
        runId: "run",
        status: "success",
        output: { narrativeOutput: "The gate opened." },
        toolCalls: [],
        durationMs: 1,
        timestamp: now,
      },
    ],
    completion: { kind: "turn", turnId: "turn", durationMs: 1 },
    executionContext: {
      executionId: "execution",
      origin: "manual",
      countPolicy: "none",
    },
    memorySystem: {
      ...memory,
      updater: { ...memory.updater, awaitPending: async () => {} },
    },
    ...(fail
      ? {
          extraInTx: async () => {
            throw new Error("rollback");
          },
        }
      : {}),
  };
  return commitExecution(args);
}
const pending = (store: DataStore, sessionId = "s") =>
  store.listPluginData(sessionId, "__memory", "_pending_updates");

describe("durable core-memory recovery", () => {
  it("commits recovery intent with the story and recovers it once using the next request's adapter", async () => {
    const store = await fixture();
    expect((await leavePending(store)).status).toBe("committed");
    expect(await pending(store)).toHaveLength(1);
    const complete = vi
      .fn()
      .mockResolvedValue({ content: '{"story_state":"The gate is open."}' });
    const restarted = boot(store, { complete });
    await restarted.updater.awaitPending("s");
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]![0].messages[0].content).toContain(
      "The gate opened.",
    );
    expect(await pending(store)).toHaveLength(0);
    expect((await restarted.manager.loadBlocks("s"))[0]!.content).toBe(
      "The gate is open.",
    );
    await boot(store, { complete }).updater.awaitPending("s");
    expect(complete).toHaveBeenCalledOnce();
  });
  it("rolls recovery intent back with a failed story transaction", async () => {
    const store = await fixture();
    expect((await leavePending(store, true)).status).toBe("failed");
    expect(await pending(store)).toHaveLength(0);
    expect(await store.listMessages("s")).toHaveLength(0);
  });
  it.each(["provider-timeout", "invalid-json"])(
    "does not replay a settled %s failure while the next turn waits",
    async (failure) => {
      const store = await fixture();
      await leavePending(store);
      const started = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const complete = vi.fn(async () => {
        started.resolve();
        await released.promise;
        if (failure === "provider-timeout") {
          throw Object.assign(new Error("The operation timed out"), {
            retriable: false,
          });
        }
        return { content: "invalid JSON" };
      });
      const memory = boot(store, { complete });
      const update = memory.updater.updateAfterTurn({
        sessionId: "s",
        turnId: "turn",
        narrativeText: "The gate opened.",
        currentBlocks: [],
      });
      await started.promise;
      const nextTurn = memory.updater.awaitPending("s");
      released.resolve();
      expect(await update).toHaveProperty("error");
      await nextTurn;
      expect(complete).toHaveBeenCalledOnce();
      expect(await pending(store)).toHaveLength(0);
      await boot(store, { complete }).updater.awaitPending("s");
      expect(complete).toHaveBeenCalledOnce();
    },
  );
  it.each(["live", "recovery"])(
    "keeps %s work pending when the final block transaction fails",
    async (path) => {
      const store = await fixture();
      await leavePending(store);
      const complete = vi
        .fn()
        .mockResolvedValue({ content: '{"story_state":"Recovered."}' });
      const broken: DataStore = {
        ...store,
        withTransaction: (fn) =>
          store.withTransaction((tx) =>
            fn({
              ...tx,
              upsertWorkingMemory: async () => {
                throw new Error("disk unavailable");
              },
            }),
          ),
      };
      const memory = boot(broken, { complete });
      if (path === "live") {
        expect(
          await memory.updater.updateAfterTurn({
            sessionId: "s",
            turnId: "turn",
            narrativeText: "The gate opened.",
            currentBlocks: [],
          }),
        ).toMatchObject({ error: "disk unavailable", persistenceFailed: true });
      } else {
        await expect(memory.updater.awaitPending("s")).rejects.toThrow(
          "disk unavailable",
        );
      }
      expect(await pending(store)).toHaveLength(1);
      expect(
        await store.getWorkingMemory("s", "story", "story_state"),
      ).toBeNull();
      await boot(store, { complete }).updater.awaitPending("s");
      expect(await pending(store)).toHaveLength(0);
    },
  );
  it("serializes separate memory systems through the host lock", async () => {
    const store = await fixture();
    await leavePending(store);
    const complete = vi.fn().mockResolvedValue({ content: "{}" });
    const lock = createInProcessSessionLock();
    const a = boot(store, { complete }, lock);
    const b = boot(store, { complete }, lock);
    await Promise.all([
      a.updater.awaitPending("s"),
      b.updater.awaitPending("s"),
    ]);
    expect(complete).toHaveBeenCalledOnce();
    expect(await pending(store)).toHaveLength(0);
  });
  it("uses the copied row's session scope when recovering forked work", async () => {
    const store = await fixture();
    await leavePending(store);
    const session = (await store.getSession("s"))!;
    await store.createSession({ ...session, id: "child" });
    const [job] = await pending(store);
    await store.setPluginData({ ...job!, id: "child-job", sessionId: "child" });
    const memory = boot(store, {
      complete: async () => ({ content: '{"story_state":"Child memory."}' }),
    });
    await memory.updater.awaitPending("child");
    expect(await pending(store, "child")).toHaveLength(0);
    expect(await pending(store)).toHaveLength(1);
    expect((await memory.manager.loadBlocks("child"))[0]!.content).toBe(
      "Child memory.",
    );
    expect((await memory.manager.loadBlocks("s"))[0]!.content).toBe("");
  });
});
