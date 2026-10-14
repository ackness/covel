import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  createFunctionStoreView,
  createPluginDataWriter,
  createRpcHandlerStoreView,
} from "../src/function-runtime/plugin-handler-helpers.js";
import { createExecutionWriteBuffer } from "../src/function-runtime/execution-write-buffer.js";

const ctx = {
  sessionId: "session",
  pluginId: "plugin",
  runtimeId: "plugin/run",
  turnId: "turn",
};
const now = "2026-01-01T00:00:00.000Z";
const row = (key: string, value: unknown, sessionId = ctx.sessionId) => ({
  id: key,
  sessionId,
  pluginId: ctx.pluginId,
  namespace: "items",
  key,
  value,
  createdAt: now,
  updatedAt: now,
});
async function fixture() {
  const store = createMemoryStore();
  await store.createSession({
    locale: "en-US",
    updatedAt: "2026-01-01T00:00:00.000Z",
    id: ctx.sessionId,
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: [ctx.pluginId],
    createdAt: now,
  });
  const buffer = createExecutionWriteBuffer();
  const scoped = createFunctionStoreView(store, ctx, buffer);
  const writer = createPluginDataWriter(store, ctx, buffer);
  return { store, buffer, scoped, writer };
}

describe("handler store ownership", () => {
  it("cannot mutate session lifecycle through methods or retained MemoryStore records", async () => {
    const { store, buffer, scoped } = await fixture();
    const rpc = createRpcHandlerStoreView(store, ctx);
    for (const handle of [scoped, rpc]) {
      for (const name of [
        "updateSession",
        "deleteSession",
        "withTransaction",
        "close",
        "compareAndSetPluginData",
        "upsertCharacter",
        "listCharacters",
        "getWorld",
      ]) {
        expect(Reflect.get(handle, name)).toBeUndefined();
      }
    }
    const readSession = (value: unknown) =>
      value as { phase: string; setupRuntimes: Record<string, unknown> };
    for (const session of [await scoped.getSession(), await rpc.getSession()]) {
      expect(session).not.toHaveProperty("status");
      expect(session).not.toHaveProperty("activePlugins");
      expect(session).not.toHaveProperty("id");
      readSession(session).phase = "setup";
      readSession(session).setupRuntimes["plugin/setup"] = { state: "pending" };
    }
    expect(await store.getSession(ctx.sessionId)).toMatchObject({
      status: "active",
      activePlugins: [ctx.pluginId],
      phase: "playing",
      setupRuntimes: {},
    });
    expect(buffer).toHaveLength(0);
  });

  it("rejects session reads after the session is deleted", async () => {
    const { store, scoped } = await fixture();
    const rpc = createRpcHandlerStoreView(store, ctx);
    await store.deleteSession(ctx.sessionId);
    for (const view of [scoped, rpc]) {
      await expect(view.getSession()).rejects.toThrow(
        "The session no longer exists",
      );
    }
  });

  it("owns buffered inputs and every returned domain value", async () => {
    const { store, scoped, writer } = await fixture();
    const single = { count: 1 };
    await writer.set("items", "single", single);
    single.count = 99;
    const change = (value: unknown) => {
      (value as { count: number }).count = 42;
    };
    change(await writer.get("items", "single"));
    change((await scoped.getPluginData("items", "single"))!.value);
    change((await writer.list("items"))[0]!.value);
    change((await scoped.listPluginData("items"))[0]!.value);
    expect(await writer.get("items", "single")).toEqual({ count: 1 });
    expect(await store.listPluginData(ctx.sessionId, ctx.pluginId)).toEqual([]);

    await store.setPluginData(row("persisted", { count: 3 }));
    change((await scoped.getPluginData("items", "persisted"))!.value);
    expect(
      (await store.getPluginData(
        ctx.sessionId,
        ctx.pluginId,
        "items",
        "persisted",
      ))!.value,
    ).toEqual({ count: 3 });
  });

  it("overlays only the execution session", async () => {
    const { store, scoped, writer } = await fixture();
    await store.setPluginDataBatch([
      row("a", 1),
      row("b", 2),
      row("a", "other", "other"),
    ]);
    await writer.delete("items", "a");
    await writer.set("items", "c", 3);
    expect(await scoped.getPluginData("items", "a")).toBeNull();
    expect((await scoped.listPluginData("items")).map((r) => r.key)).toEqual([
      "b",
      "c",
    ]);
    // Extra forged identity arguments cannot alter the bound store authority.
    expect(
      await Reflect.apply(scoped.getPluginData, scoped, [
        "other",
        ctx.pluginId,
        "items",
        "a",
      ]),
    ).toBeNull();
    expect(
      (await store.getPluginData(ctx.sessionId, ctx.pluginId, "items", "a"))!
        .value,
    ).toBe(1);
  });
});
