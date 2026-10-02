/**
 * Tests for the per-runtime handler helpers — scoped plugin-data writer
 * + logger. Both are handed to function-runtime handlers via
 * `FunctionHandlerContext` so plugins can write placeholder frames /
 * diagnostics without bypassing the pluginId scope.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import {
  createFunctionStoreView,
  createPluginDataWriter,
  createPluginLogger,
} from "../src/function-runtime/plugin-handler-helpers.js";

const SESSION_ID = "sess-hh-1";
const PLUGIN_ID = "my-plugin";
const RUNTIME_ID = "my-plugin/runner";
const TURN_ID = "turn-hh-1";

let store: DataStore;

beforeEach(() => {
  store = createMemoryStore();
});

describe("createPluginDataWriter", () => {
  const ctx = {
    sessionId: SESSION_ID,
    pluginId: PLUGIN_ID,
    runtimeId: RUNTIME_ID,
    turnId: TURN_ID,
  };

  it("writes plugin_data scoped to the runtime pluginId", async () => {
    const writer = createPluginDataWriter(store, ctx);
    await writer.set("images", "img-1", { status: "pending" });

    const row = await store.getPluginData(
      SESSION_ID,
      PLUGIN_ID,
      "images",
      "img-1",
    );
    expect(row?.value).toEqual({ status: "pending" });
  });

  it("overwrites existing rows on repeat set", async () => {
    const writer = createPluginDataWriter(store, ctx);
    await writer.set("images", "img-1", { status: "pending" });
    await writer.set("images", "img-1", { status: "done", url: "x" });

    const row = await store.getPluginData(
      SESSION_ID,
      PLUGIN_ID,
      "images",
      "img-1",
    );
    expect(row?.value).toEqual({ status: "done", url: "x" });
  });

  it("deletes when value is null", async () => {
    const writer = createPluginDataWriter(store, ctx);
    await writer.set("images", "img-1", { status: "pending" });
    await writer.set("images", "img-1", null);

    const row = await store.getPluginData(
      SESSION_ID,
      PLUGIN_ID,
      "images",
      "img-1",
    );
    expect(row).toBeNull();
  });

  it("list returns entries for the given namespace", async () => {
    const writer = createPluginDataWriter(store, ctx);
    await writer.set("images", "img-1", { status: "pending" });
    await writer.set("images", "img-2", { status: "done" });
    await writer.set("other", "x", { something: "else" });

    const entries = await writer.list("images");
    expect(entries.map((e) => e.key).sort()).toEqual(["img-1", "img-2"]);
  });

  it("get returns null for missing key", async () => {
    const writer = createPluginDataWriter(store, ctx);
    expect(await writer.get("images", "missing")).toBeNull();
  });
});

describe("createPluginLogger", () => {
  const ctx = {
    sessionId: SESSION_ID,
    pluginId: PLUGIN_ID,
    runtimeId: RUNTIME_ID,
    turnId: TURN_ID,
  };

  it("appends rows to the plugin _logs namespace", async () => {
    const logger = createPluginLogger(store, ctx);
    await logger.info("hello", { foo: "bar" });

    const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_logs");
    expect(rows).toHaveLength(1);
    const entry = rows[0].value as {
      level: string;
      message: string;
      meta: Record<string, unknown>;
      runtimeId: string;
      turnId: string;
      timestamp: string;
    };
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("hello");
    expect(entry.meta).toEqual({ foo: "bar" });
    expect(entry.runtimeId).toBe(RUNTIME_ID);
    expect(entry.turnId).toBe(TURN_ID);
    expect(typeof entry.timestamp).toBe("string");
  });

  it("preserves all severity levels", async () => {
    const logger = createPluginLogger(store, ctx);
    await logger.debug("d");
    await logger.info("i");
    await logger.warn("w");
    await logger.error("e");

    const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_logs");
    const levels = rows.map((r) => (r.value as { level: string }).level).sort();
    expect(levels).toEqual(["debug", "error", "info", "warn"]);
  });

  it("omits the meta field when no metadata is provided", async () => {
    const logger = createPluginLogger(store, ctx);
    await logger.info("no-meta");
    const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_logs");
    expect(rows[0].value).not.toHaveProperty("meta");
  });

  it("records only levels at or above the configured threshold", async () => {
    const previous = process.env.COVEL_PLUGIN_LOG_LEVEL;
    process.env.COVEL_PLUGIN_LOG_LEVEL = "warn";
    try {
      const logger = createPluginLogger(store, ctx);
      await logger.debug("d");
      await logger.info("i");
      await logger.warn("w");
      await logger.error("e");
    } finally {
      if (previous === undefined) delete process.env.COVEL_PLUGIN_LOG_LEVEL;
      else process.env.COVEL_PLUGIN_LOG_LEVEL = previous;
    }
    const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_logs");
    expect(
      rows.map((r) => (r.value as { level: string }).level).sort(),
    ).toEqual(["error", "warn"]);
  });

  it("skips debug lines in production by default", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const logger = createPluginLogger(store, ctx);
      await logger.debug("d");
      await logger.info("i");
    } finally {
      process.env.NODE_ENV = previous;
    }
    const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_logs");
    expect(rows.map((r) => (r.value as { level: string }).level)).toEqual([
      "info",
    ]);
  });

  it("bounds the ring without reading the namespace on every write", async () => {
    let reads = 0;
    const countingStore = {
      ...store,
      listPluginData: (...args: Parameters<DataStore["listPluginData"]>) => {
        reads += 1;
        return store.listPluginData(...args);
      },
    } as DataStore;
    const chatty = createPluginLogger(countingStore, ctx);
    for (let i = 0; i < 230; i += 1) await chatty.info(`line ${i}`);
    expect(reads).toBe(12);
    expect(
      (await store.listPluginData(SESSION_ID, PLUGIN_ID, "_logs")).length,
    ).toBeLessThanOrEqual(220);

    await createPluginLogger(store, ctx).info("next execution");
    const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_logs");
    expect(rows).toHaveLength(200);
    expect(
      rows.map((row) => (row.value as { message: string }).message),
    ).toContain("next execution");
  });

  it("never throws when the store rejects writes", async () => {
    const rejectingStore = {
      ...store,
      setPluginData: async () => {
        throw new Error("boom");
      },
    } as unknown as DataStore;

    const logger = createPluginLogger(rejectingStore, ctx);
    await expect(
      logger.error("this should be swallowed"),
    ).resolves.toBeUndefined();
  });
});

describe("createFunctionStoreView", () => {
  const ctx = {
    sessionId: SESSION_ID,
    pluginId: PLUGIN_ID,
    runtimeId: RUNTIME_ID,
    turnId: TURN_ID,
  };

  it("binds submitted input reads to the current session even with a forged argument", async () => {
    for (const sessionId of [SESSION_ID, "other-session"]) {
      await store.savePlayerInput({
        id: sessionId,
        sessionId,
        turnId: TURN_ID,
        formId: "allocation",
        values: { points: 3 },
        createdAt: "2024-01-01T00:00:00Z",
      });
    }
    const view = createFunctionStoreView(store, ctx);
    expect(
      (await view.listPlayerInputs("other-session")).map((input) => input.id),
    ).toEqual([SESSION_ID]);
  });

  it("binds plugin_data reads to the calling pluginId", async () => {
    await store.setPluginData({
      id: "own-row",
      sessionId: SESSION_ID,
      pluginId: PLUGIN_ID,
      namespace: "notes",
      key: "a",
      value: { owner: "self" },
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    await store.setPluginData({
      id: "other-row",
      sessionId: SESSION_ID,
      pluginId: "other-plugin",
      namespace: "notes",
      key: "a",
      value: { owner: "other" },
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    const view = createFunctionStoreView(store, ctx);

    expect((await view.getPluginData("notes", "a"))?.value).toEqual({
      owner: "self",
    });
    const rows = await view.listPluginData("notes");
    expect(rows.map((r) => r.value)).toEqual([{ owner: "self" }]);
  });

  it("pages the full session timeline with an opaque cursor", async () => {
    for (const [i, sessionId] of [
      SESSION_ID,
      SESSION_ID,
      "other-session",
      SESSION_ID,
    ].entries()) {
      await store.appendTurnMessage({
        id: `m${i}`,
        sessionId,
        turnId: `t${i}`,
        sourceType: i % 2 === 0 ? "player" : "runtime",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
        order: 0,
        createdAt: `2024-01-01T00:00:0${i}Z`,
      });
    }
    await store.tagTurnMessagesCompacted(SESSION_ID, ["m0"], "summary-1");
    const view = createFunctionStoreView(store, ctx);

    const first = await view.readTurnMessages({ limit: 2 });
    expect(first.messages.map((m) => [m.id, m.compacted])).toEqual([
      ["m0", true],
      ["m1", false],
    ]);
    expect(first.messages[0]).not.toHaveProperty("sessionId");
    expect(first.hasMore).toBe(true);
    const second = await view.readTurnMessages({
      after: first.cursor!,
      limit: 2,
    });
    expect(second.messages.map((m) => m.id)).toEqual(["m3"]);
    expect(second.hasMore).toBe(false);
    // The end cursor resumes later: new messages appear after it.
    await store.appendTurnMessage({
      id: "m4",
      sessionId: SESSION_ID,
      turnId: "t4",
      sourceType: "player",
      role: "user",
      content: "message 4",
      order: 0,
      createdAt: "2024-01-01T00:00:04Z",
    });
    const resumed = await view.readTurnMessages({ after: second.cursor! });
    expect(resumed.messages.map((m) => m.id)).toEqual(["m4"]);
    const empty = await view.readTurnMessages({ after: resumed.cursor! });
    expect(empty).toMatchObject({
      messages: [],
      cursor: resumed.cursor,
      hasMore: false,
    });
    await expect(view.readTurnMessages({ after: "forged" })).rejects.toThrow(
      "Invalid turn message cursor",
    );
    await expect(view.readTurnMessages({ limit: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});
