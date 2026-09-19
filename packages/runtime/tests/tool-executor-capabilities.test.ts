import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { Proposal, ProposalFor } from "@covel/shared";
import {
  tool,
  z,
  withPendingProposals,
  withEmittedEvents,
  shortIdBatch,
  type ToolExecutionContext,
} from "@covel/tools";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import upsertQuests from "../../../plugins/core-quest/tools/upsert-quests.js";
import listNpcGraph from "../../../plugins/npc-graph/tools/list-npc-graph.js";
import syncCodexEntries from "../../../plugins/codex/tools/sync-codex-entries.js";

const identity = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "plugin",
  runtimeId: "plugin/main",
};
const call = { toolCallId: "call", name: "read", arguments: "{}" };
function write(value: unknown, patch: Partial<Proposal> = {}): Proposal {
  return {
    id: crypto.randomUUID(),
    type: "plugin.data",
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    source: { pluginId: identity.pluginId, runtimeId: identity.runtimeId },
    timestamp: "2026-09-19T00:00:00Z",
    payload: { namespace: "data", key: "key", value },
    ...patch,
  } as Proposal;
}
function makeTool(execute: (ctx: ToolExecutionContext) => Promise<unknown>) {
  return tool({
    name: call.name,
    description: "Fixture",
    parameters: z.object({}),
    execute: (_args, ctx) => execute(ctx),
  });
}
async function fixture() {
  const store = createMemoryStore();
  await store.setPluginData({
    id: "row",
    sessionId: identity.sessionId,
    pluginId: identity.pluginId,
    namespace: "data",
    key: "key",
    value: { count: 1 },
    createdAt: "t",
    updatedAt: "t",
  });
  return store;
}

describe("tool invocation capabilities", () => {
  it("preserves additions made between direct child calls inside a composite tool", async () => {
    const store = await fixture();
    const entryId = "codex-port";
    const module = syncCodexEntries({ tool, z, shortIdBatch: () => [entryId] });
    const executor = createToolExecutor({ store, findTool: () => module });
    const title = "Synthetic port";
    const result = await executor.execute(
      {
        ...call,
        name: module.name,
        arguments: JSON.stringify({
          unlocks: [
            {
              title,
              category: "location",
              content: "A synthetic port for this regression.",
              tags: ["port"],
              rarity: "common",
            },
          ],
          updates: [
            { entryId, appendContent: "First addition." },
            { entryId, appendContent: "Second addition." },
          ],
        }),
      },
      identity,
    );
    expect(result.success, result.result).toBe(true);
    expect(result.parsedResult).toMatchObject({ unlocked: 1, updated: 2 });
    const proposals = result.pendingProposals!;
    expect(proposals).toHaveLength(3);
    expect(proposals[2]!.payload).toMatchObject({
      value: {
        content:
          "A synthetic port for this regression.\n\nFirst addition.\n\nSecond addition.",
      },
    });
    expect(
      await store.listPluginData(
        identity.sessionId,
        identity.pluginId,
        "entries",
      ),
    ).toEqual([]);
  });
  it("drains reads a tool did not await before the invocation releases its store", async () => {
    const store = await fixture();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    vi.spyOn(store, "getPluginData").mockImplementation(async () => {
      reading.resolve();
      await release.promise;
      return null;
    });
    let read: Promise<unknown>;
    const content = { accepted: true };
    const module = makeTool(async (ctx) => {
      read = ctx.store!.getPluginData("data", "key");
      returned.resolve();
      return content;
    });
    const record = vi.spyOn(store, "saveToolCall");
    const settled = vi.fn();
    const running = createToolExecutor({ store, findTool: () => module })
      .execute(call, identity)
      .then((result) => {
        settled();
        return result;
      });
    await reading.promise;
    await returned.promise;
    // The invocation has already closed its read capability and copied output.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    content.accepted = false;
    release.resolve();
    expect((await running).parsedResult).toEqual({ accepted: true });
    await expect(read!).rejects.toThrow("completed");
  });
  it("keeps completed quest objectives across two uncommitted tool calls", async () => {
    const store = await fixture();
    const module = upsertQuests({ tool, z, shortIdBatch });
    const executor = createToolExecutor({ store, findTool: () => module });
    const context = {
      ...identity,
      pluginId: "core-quest",
      runtimeId: "core-quest/main",
    };
    const invoke = (
      quests: unknown[],
      pendingProposals: readonly Proposal[] = [],
    ) =>
      executor.execute(
        { ...call, name: module.name, arguments: JSON.stringify({ quests }) },
        { ...context, pendingProposals },
      );
    const first = await invoke([
      {
        name: "Find map",
        status: "completed",
        objectives: [{ text: "Reach port", done: true }],
      },
    ]);
    const second = await invoke(
      [{ name: "Find map", reward: "Compass" }],
      first.pendingProposals,
    );
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const proposal = second.pendingProposals!.find(
      (p) => p.type === "plugin.data.batch",
    ) as ProposalFor<"plugin.data.batch">;
    expect(
      proposal.payload.items.find((item) => item.namespace === "quests")!.value,
    ).toMatchObject({
      status: "completed",
      reward: "Compass",
      objectives: [expect.objectContaining({ done: true })],
    });
    expect(
      await store.listPluginData(context.sessionId, context.pluginId, "quests"),
    ).toEqual([]);
  });

  it("lists newly proposed graph nodes before commit", async () => {
    const store = await fixture();
    const module = listNpcGraph({ tool, z });
    const executor = createToolExecutor({ store, findTool: () => module });
    const pending = write(null, {
      payload: {
        namespace: "nodes",
        key: "alice",
        value: { id: "alice", name: "Alice" },
      },
    });
    const result = await executor.execute(
      { ...call, name: module.name },
      { ...identity, pendingProposals: [pending] },
    );
    expect(result.success).toBe(true);
    expect(result.parsedResult).toMatchObject({
      nodeCount: 1,
      nodes: [expect.objectContaining({ name: "Alice" })],
    });
    expect(
      await store.listPluginData(
        identity.sessionId,
        identity.pluginId,
        "nodes",
      ),
    ).toEqual([]);
  });
  it("owns read values and overlays set, batch and delete in order without persisting", async () => {
    const store = await fixture();
    const pending: Proposal[] = [write({ count: 2 })];
    let retained: ToolExecutionContext["store"];
    const module = makeTool(async (ctx) => {
      retained = ctx.store;
      expect(ctx.store).not.toHaveProperty("close");
      expect(ctx.store).not.toHaveProperty("withTransaction");
      expect(ctx.store).not.toHaveProperty("setPluginData");
      const before = await ctx.store!.getPluginData("data", "key");
      if (before) (before.value as { count: number }).count = 999;
      const forged = ctx.pendingProposals![0] as ProposalFor<"plugin.data">;
      (forged.payload.value as { count: number }).count = 999;
      return ctx.store!.listPluginData("data");
    });
    const executor = createToolExecutor({ store, findTool: () => module });
    expect(
      (await executor.execute(call, { ...identity, pendingProposals: pending }))
        .parsedResult,
    ).toEqual([expect.objectContaining({ value: { count: 2 } })]);
    expect((pending[0] as ProposalFor<"plugin.data">).payload.value).toEqual({
      count: 2,
    });
    await expect(retained!.getPluginData("data", "key")).rejects.toThrow(
      "completed",
    );
    pending.push(
      write(null, {
        type: "plugin.data.delete",
        payload: { namespace: "data", key: "key" },
      }),
    );
    expect(
      (await executor.execute(call, { ...identity, pendingProposals: pending }))
        .parsedResult,
    ).toEqual([]);
    pending.push(
      write(null, {
        type: "plugin.data.batch",
        payload: {
          items: [{ namespace: "data", key: "key", value: { count: 3 } }],
        },
      }),
    );
    pending.push(write({ count: 888 }, { sessionId: "foreign" }));
    pending.push(
      write(
        { count: 777 },
        { source: { pluginId: "foreign", runtimeId: "foreign/main" } },
      ),
    );
    expect(
      (await executor.execute(call, { ...identity, pendingProposals: pending }))
        .parsedResult,
    ).toEqual([expect.objectContaining({ value: { count: 3 } })]);
    expect(
      (await store.getPluginData(
        identity.sessionId,
        identity.pluginId,
        "data",
        "key",
      ))!.value,
    ).toEqual({ count: 1 });
  });

  it("owns inputs and returned proposals/events before waiting for persistence", async () => {
    const store = await fixture();
    const recording = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(store, "saveToolCall").mockImplementation(async () => {
      recording.resolve();
      await release.promise;
    });
    const proposal = write({ count: 2 });
    const content = { ok: true };
    const events = [{ topic: "test", data: { count: 2 } }];
    const inputs = {
      value: { cardinality: "one" as const, value: { count: 1 } },
    };
    const topics = ["earlier"];
    let retained: ToolExecutionContext["store"];
    const module = makeTool(async (ctx) => {
      retained = ctx.store;
      (ctx.inputSlots!.value!.value as { count: number }).count = 999;
      (ctx.emittedEventTopics as string[]).push("injected");
      return withEmittedEvents(
        withPendingProposals(content, [proposal]),
        events,
      );
    });
    const executor = createToolExecutor({ store, findTool: () => module });
    const result = executor.execute(call, {
      ...identity,
      inputSlots: inputs,
      emittedEventTopics: topics,
    });
    await recording.promise;
    await expect(retained!.getSession()).rejects.toThrow("completed");
    content.ok = false;
    (
      (proposal as ProposalFor<"plugin.data">).payload.value as {
        count: number;
      }
    ).count = 999;
    events[0]!.data.count = 999;
    release.resolve();
    const completed = await result;
    expect(completed.parsedResult).toEqual({ ok: true });
    expect(completed.pendingProposals![0]!.payload).toMatchObject({
      value: { count: 2 },
    });
    expect(completed.emittedEvents).toEqual([
      { topic: "test", data: { count: 2 } },
    ]);
    expect(inputs.value.value.count).toBe(1);
    expect(topics).toEqual(["earlier"]);
  });

  it("rejects cancellation before invocation and after asynchronous trace admission", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => null);
    const module = makeTool(execute);
    const executor = createToolExecutor({ findTool: () => module });
    const emitter = {
      emit: vi.fn(async (type: string) => {
        if (type === "tool.calling") controller.abort(new Error("stopped"));
      }),
    } as unknown as TurnEmitter;
    const result = await executor.execute(call, {
      ...identity,
      signal: controller.signal,
      emitter,
    });
    expect(JSON.parse(result.result).code).toBe("CANCELLED");
    expect(execute).not.toHaveBeenCalled();
    await expect(
      executor.execute(call, { ...identity, signal: controller.signal }),
    ).rejects.toThrow("stopped");
    expect(execute).not.toHaveBeenCalled();
  });

  it("revokes in-flight and retained reads on cancellation and discards late proposals", async () => {
    const store = await fixture();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const get = vi
      .spyOn(store, "getPluginData")
      .mockImplementation(async () => {
        reading.resolve();
        await release.promise;
        return null;
      });
    let retained: ToolExecutionContext["store"];
    const module = makeTool(async (ctx) => {
      expect(ctx.signal?.aborted).toBe(false);
      retained = ctx.store;
      await expect(ctx.store!.getPluginData("data", "key")).rejects.toThrow(
        "stopped",
      );
      expect(ctx.signal?.aborted).toBe(true);
      return withPendingProposals({ late: true }, [write(2)]);
    });
    const executor = createToolExecutor({ store, findTool: () => module });
    const running = executor.execute(call, {
      ...identity,
      signal: controller.signal,
    });
    await reading.promise;
    controller.abort(new Error("stopped"));
    await expect(retained!.getPluginData("data", "key")).rejects.toThrow(
      "stopped",
    );
    expect(get).toHaveBeenCalledTimes(1);
    release.resolve();
    const result = await running;
    expect(result.success).toBe(false);
    expect(JSON.parse(result.result).code).toBe("CANCELLED");
    expect(result.pendingProposals).toBeUndefined();
  });

  it("revokes reads when the tool throws", async () => {
    const store = await fixture();
    let retained: ToolExecutionContext["store"];
    const module = makeTool(async (ctx) => {
      retained = ctx.store;
      throw new Error("failed");
    });
    const result = await createToolExecutor({
      store,
      findTool: () => module,
    }).execute(call, identity);
    expect(result.success).toBe(false);
    await expect(retained!.listPluginData("data")).rejects.toThrow("completed");
  });
});
