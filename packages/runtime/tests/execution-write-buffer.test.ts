/**
 * Effects isolation (W3d): function-runtime / agent-guard domain writes buffer
 * into proposals instead of hitting the store directly, and reads overlay the
 * buffer so a handler/guard sees its own not-yet-committed writes. The buffer
 * flushes onto the runtime result, so processRuntimeResult commits it through
 * the normal pipeline — even when the result is a SKIPPED pre-game guard.
 */

import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@covel/store";
import { withPendingProposals } from "@covel/tools";
import type { Proposal } from "@covel/shared";
import {
  createPluginDataWriter,
  createTrustedHandlerStore,
} from "../src/function-runtime/plugin-handler-helpers.js";
import { createExecutionWriteBuffer } from "../src/function-runtime/execution-write-buffer.js";
import { processRuntimeResult } from "../src/session/session-runtime-result.js";

const CTX = {
  sessionId: "sess-1",
  turnId: "turn-1",
  pluginId: "world-init",
  runtimeId: "world-init/schema-gen",
};

function pluginDataProposal(): Proposal {
  return {
    id: crypto.randomUUID(),
    type: "plugin.data",
    source: { pluginId: CTX.pluginId, runtimeId: CTX.runtimeId },
    turnId: CTX.turnId,
    sessionId: CTX.sessionId,
    payload: {
      namespace: "schema",
      key: "character-attributes",
      value: { version: 1, attributes: [] },
    },
    timestamp: new Date().toISOString(),
  };
}

describe("createTrustedHandlerStore with a write buffer", () => {
  it("buffers setPluginData / setPluginDataBatch / upsertCharacter instead of writing", async () => {
    const store = createMemoryStore();
    const buffer = createExecutionWriteBuffer();
    const trusted = createTrustedHandlerStore(store, CTX, buffer);
    const now = new Date().toISOString();

    await trusted.setPluginData({
      id: "x",
      sessionId: CTX.sessionId,
      pluginId: CTX.pluginId,
      namespace: "schema",
      key: "character-attributes",
      value: { version: 1 },
      createdAt: now,
      updatedAt: now,
    });
    await trusted.setPluginDataBatch([
      {
        id: "e1",
        sessionId: CTX.sessionId,
        pluginId: CTX.pluginId,
        namespace: "entries",
        key: "geo",
        value: { a: 1 },
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await trusted.upsertCharacter({
      id: "char-1",
      sessionId: CTX.sessionId,
      name: "Player",
      type: "player",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    // Nothing landed in the store.
    expect(
      await store.getPluginData(
        CTX.sessionId,
        CTX.pluginId,
        "schema",
        "character-attributes",
      ),
    ).toBeNull();
    expect(await store.listCharacters(CTX.sessionId)).toHaveLength(0);

    // The buffer holds three proposals, source-bound to the runtime.
    expect(buffer.map((p) => p.type)).toEqual([
      "plugin.data",
      "plugin.data.batch",
      "character.upsert",
    ]);
    expect(buffer.every((p) => p.source.pluginId === CTX.pluginId)).toBe(true);
  });

  it("overlays buffered writes on getPluginData / listPluginData / listCharacters", async () => {
    const store = createMemoryStore();
    const buffer = createExecutionWriteBuffer();
    const trusted = createTrustedHandlerStore(store, CTX, buffer);
    const now = new Date().toISOString();

    await trusted.setPluginData({
      id: "x",
      sessionId: CTX.sessionId,
      pluginId: CTX.pluginId,
      namespace: "schema",
      key: "k",
      value: { hi: true },
      createdAt: now,
      updatedAt: now,
    });
    await trusted.upsertCharacter({
      id: "char-1",
      sessionId: CTX.sessionId,
      name: "Player",
      type: "player",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    const row = await trusted.getPluginData(
      CTX.sessionId,
      CTX.pluginId,
      "schema",
      "k",
    );
    expect(row?.value).toEqual({ hi: true });

    const list = await trusted.listPluginData(
      CTX.sessionId,
      CTX.pluginId,
      "schema",
    );
    expect(list.map((r) => r.key)).toContain("k");

    const chars = await trusted.listCharacters(CTX.sessionId);
    expect(chars.map((c) => c.id)).toContain("char-1");
  });

  it("without a buffer keeps the legacy direct-write behaviour", async () => {
    const store = createMemoryStore();
    const trusted = createTrustedHandlerStore(store);
    const now = new Date().toISOString();
    await trusted.setPluginData({
      id: "x",
      sessionId: CTX.sessionId,
      pluginId: CTX.pluginId,
      namespace: "schema",
      key: "k",
      value: 1,
      createdAt: now,
      updatedAt: now,
    });
    expect(
      await store.getPluginData(CTX.sessionId, CTX.pluginId, "schema", "k"),
    ).not.toBeNull();
  });
});

describe("createPluginDataWriter with a write buffer", () => {
  it("set buffers, get/list overlay, delete stays direct", async () => {
    const store = createMemoryStore();
    const buffer = createExecutionWriteBuffer();
    const writer = createPluginDataWriter(store, CTX, buffer);

    await writer.set("generated", "img-1", { url: "a" });
    expect(buffer).toHaveLength(1);
    // Store untouched, but the writer reads its own buffered value.
    expect(
      await store.getPluginData(
        CTX.sessionId,
        CTX.pluginId,
        "generated",
        "img-1",
      ),
    ).toBeNull();
    expect(await writer.get("generated", "img-1")).toEqual({ url: "a" });
    const list = await writer.list("generated");
    expect(list).toEqual([{ key: "img-1", value: { url: "a" } }]);

    // delete is a direct write (no delete proposal exists) — it must not
    // buffer, and it clears any committed row.
    const now = new Date().toISOString();
    await store.setPluginData({
      id: "committed",
      sessionId: CTX.sessionId,
      pluginId: CTX.pluginId,
      namespace: "generated",
      key: "img-2",
      value: 1,
      createdAt: now,
      updatedAt: now,
    });
    await writer.delete("generated", "img-2");
    expect(buffer).toHaveLength(1); // unchanged
    expect(
      await store.getPluginData(
        CTX.sessionId,
        CTX.pluginId,
        "generated",
        "img-2",
      ),
    ).toBeNull();
  });
});

describe("processRuntimeResult and non-success results", () => {
  it("commits a skipped pre-game guard's buffered writes", async () => {
    const store = createMemoryStore();
    const output: Record<string, unknown> = { skip: true, preGameDone: true };
    withPendingProposals(output, [pluginDataProposal()]);

    const out = await processRuntimeResult(
      {
        pluginId: CTX.pluginId,
        runtimeId: CTX.runtimeId,
        turnId: CTX.turnId,
        status: "skipped",
        output,
      },
      store,
      CTX.sessionId,
      "system",
    );

    expect(out.failedProposals).toHaveLength(0);
    const row = await store.getPluginData(
      CTX.sessionId,
      CTX.pluginId,
      "schema",
      "character-attributes",
    );
    expect(row?.value).toEqual({ version: 1, attributes: [] });
  });

  it("a skipped result with no pending proposals commits nothing", async () => {
    const store = createMemoryStore();
    const out = await processRuntimeResult(
      {
        pluginId: CTX.pluginId,
        runtimeId: CTX.runtimeId,
        turnId: CTX.turnId,
        status: "skipped",
        output: { skip: true },
      },
      store,
      CTX.sessionId,
      "system",
    );
    expect(out.events).toHaveLength(0);
    expect(out.failedProposals).toHaveLength(0);
  });

  it("a FAILED result never commits its pending proposals", async () => {
    const store = createMemoryStore();
    const output: Record<string, unknown> = { error: "boom" };
    withPendingProposals(output, [pluginDataProposal()]);

    await processRuntimeResult(
      {
        pluginId: CTX.pluginId,
        runtimeId: CTX.runtimeId,
        turnId: CTX.turnId,
        status: "failed",
        output,
      },
      store,
      CTX.sessionId,
      "system",
    );

    // A failed runtime's buffered writes must be dropped, not committed.
    expect(
      await store.getPluginData(
        CTX.sessionId,
        CTX.pluginId,
        "schema",
        "character-attributes",
      ),
    ).toBeNull();
  });
});
