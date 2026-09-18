import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import {
  createTrustedHandlerStore,
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
const character = (sessionId = ctx.sessionId) => ({
  id: "hero",
  sessionId,
  name: "Hero",
  type: "player" as const,
  fields: { hp: 1 },
  version: 1,
  createdAt: now,
  updatedAt: now,
});

async function fixture() {
  const store = createMemoryStore();
  await store.createSession({
    id: ctx.sessionId,
    worldId: null,
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: [ctx.pluginId],
    createdAt: now,
  });
  const buffer = createExecutionWriteBuffer();
  const trusted = createTrustedHandlerStore(store, ctx, buffer);
  const scoped = createFunctionStoreView(store, ctx, buffer);
  const writer = createPluginDataWriter(store, ctx, buffer);
  return { store, buffer, trusted, scoped, writer };
}

describe("handler store ownership", () => {
  it("cannot mutate session lifecycle through methods or retained MemoryStore records", async () => {
    const { store, buffer, trusted, scoped } = await fixture();
    const rpc = createRpcHandlerStoreView(store, ctx);
    for (const handle of [trusted, scoped, rpc]) {
      for (const name of [
        "updateSession",
        "deleteSession",
        "withTransaction",
        "close",
        "compareAndSetPluginData",
      ]) {
        expect(Reflect.get(handle, name)).toBeUndefined();
      }
    }
    const readSession = (value: unknown) =>
      value as { status: string; activePlugins: string[] };
    for (const session of [
      await trusted.getSession(ctx.sessionId),
      await scoped.getSession(),
      await rpc.getSession(ctx.sessionId),
    ]) {
      readSession(session).status = "ended";
      readSession(session).activePlugins.length = 0;
    }
    expect(await store.getSession(ctx.sessionId)).toMatchObject({
      status: "active",
      activePlugins: [ctx.pluginId],
    });
    expect(buffer).toHaveLength(0);
  });

  it("owns buffered inputs and every returned domain value", async () => {
    const { store, trusted, scoped, writer } = await fixture();
    const single = { count: 1 };
    const batch = { count: 2 };
    const hero = character();
    await trusted.setPluginData(row("single", single));
    await trusted.setPluginDataBatch([row("batch", batch)]);
    await trusted.upsertCharacter(hero);
    single.count = 99;
    batch.count = 99;
    hero.fields.hp = 99;
    const change = (value: unknown) => {
      (value as { count: number }).count = 42;
    };
    change(await writer.get("items", "single"));
    change((await scoped.getPluginData("items", "single"))!.value);
    change((await writer.list("items"))[0]!.value);
    change((await trusted.listPluginDataSessionScope(ctx.sessionId))[0]!.value);
    (await trusted.listCharacters(ctx.sessionId))[0]!.fields!.hp = 42;
    expect(await writer.get("items", "single")).toEqual({ count: 1 });
    expect(await writer.get("items", "batch")).toEqual({ count: 2 });
    expect((await trusted.listCharacters(ctx.sessionId))[0]!.fields).toEqual({
      hp: 1,
    });
    expect(await store.listPluginData(ctx.sessionId, ctx.pluginId)).toEqual([]);
    expect(await store.listCharacters(ctx.sessionId)).toEqual([]);

    await store.setPluginData(row("persisted", { count: 3 }));
    change(
      (await trusted.getPluginData(
        ctx.sessionId,
        ctx.pluginId,
        "items",
        "persisted",
      ))!.value,
    );
    expect(
      (await store.getPluginData(
        ctx.sessionId,
        ctx.pluginId,
        "items",
        "persisted",
      ))!.value,
    ).toEqual({ count: 3 });
  });

  it("overlays only the execution session and paginates after deletes and appends", async () => {
    const { store, trusted, scoped, writer } = await fixture();
    await store.setPluginDataBatch([
      row("a", 1),
      row("b", 2),
      row("a", "other", "other"),
    ]);
    await store.upsertCharacter(character("other"));
    await writer.delete("items", "a");
    await writer.set("items", "c", 3);
    await trusted.upsertCharacter({ ...character(), name: "Buffered" });
    expect(await scoped.getPluginData("items", "a")).toBeNull();
    expect((await scoped.listPluginData("items")).map((r) => r.key)).toEqual([
      "b",
      "c",
    ]);
    expect(
      (
        await trusted.listPluginData(ctx.sessionId, ctx.pluginId, "items", {
          limit: 1,
        })
      ).map((r) => r.key),
    ).toEqual(["b"]);
    expect(
      (
        await trusted.listPluginDataSessionScope(ctx.sessionId, {
          offset: 1,
          limit: 1,
        })
      ).map((r) => r.key),
    ).toEqual(["c"]);
    expect(
      (await trusted.getPluginData("other", ctx.pluginId, "items", "a"))!.value,
    ).toBe("other");
    expect(
      (await trusted.listPluginData("other", ctx.pluginId)).map((r) => r.value),
    ).toEqual(["other"]);
    expect((await trusted.listCharacters("other"))[0]!.name).toBe("Hero");
    expect(
      (await store.getPluginData(ctx.sessionId, ctx.pluginId, "items", "a"))!
        .value,
    ).toBe(1);

    // A stored null is a value; a delete removes the row entirely.
    await trusted.setPluginData(row("null", null));
    expect(await scoped.getPluginData("items", "null")).toMatchObject({
      value: null,
    });
    await writer.delete("items", "null");
    expect(await scoped.getPluginData("items", "null")).toBeNull();
  });
});
