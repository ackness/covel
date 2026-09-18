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
import type { Proposal, CharacterUpsertPayload } from "@covel/shared";
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
  it.each(["patch", "replace", "null", "array"] as const)(
    "materializes pending character %s with the same semantics as the real commit",
    async (operation) => {
      const store = createMemoryStore();
      const initial = {
        id: "char-patch",
        sessionId: CTX.sessionId,
        name: "Probe",
        type: "player",
        description: "old",
        fields: { hp: 10, mp: 5 },
        version: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      await store.upsertCharacter(initial);
      const buffer = createExecutionWriteBuffer();
      const append = (payload: CharacterUpsertPayload) =>
        buffer.push({
          id: crypto.randomUUID(),
          type: "character.upsert",
          sessionId: CTX.sessionId,
          turnId: CTX.turnId,
          source: { pluginId: CTX.pluginId, runtimeId: CTX.runtimeId },
          timestamp: initial.updatedAt,
          payload,
        });
      if (operation === "patch") {
        append({
          id: initial.id,
          name: "ignored for patches",
          type: "npc",
          expectedVersion: 3,
          fields: { hp: 8 },
        });
        append({
          id: initial.id,
          name: "ignored again",
          expectedVersion: 3,
          fields: { mp: 4 },
        });
        append({
          id: initial.id,
          name: "ignored",
          expectedVersion: 4,
          description: "",
        });
      } else if (operation === "replace") {
        append({
          id: initial.id,
          name: "Replacement",
          type: "npc",
          version: 1,
          createdAt: initial.createdAt,
          fields: { luck: 2 },
        });
        append({
          id: initial.id,
          name: "ignored",
          expectedVersion: 1,
          fields: { hp: 9 },
        });
      } else {
        append({
          id: initial.id,
          name: initial.name,
          expectedVersion: 3,
          fields: operation === "null" ? null : ["marker"],
        });
        append({
          id: initial.id,
          name: initial.name,
          expectedVersion: 4,
          description: "",
        });
      }
      const trusted = createTrustedHandlerStore(store, CTX, buffer);
      const before = (await trusted.listCharacters(CTX.sessionId))[0]!;
      expect(await store.listCharacters(CTX.sessionId)).toEqual([initial]);
      const result = await processRuntimeResult(
        {
          pluginId: CTX.pluginId,
          runtimeId: CTX.runtimeId,
          turnId: CTX.turnId,
          status: "success",
          output: withPendingProposals({}, buffer),
        },
        store,
        CTX.sessionId,
        "system",
      );
      expect(result.failedProposals).toEqual([]);
      const after = (await store.listCharacters(CTX.sessionId))[0]!;
      const { updatedAt: _beforeTime, ...beforeState } = before;
      const { updatedAt: _afterTime, ...afterState } = after;
      expect(beforeState).toEqual(afterState);
      expect(before).toMatchObject(
        operation === "patch"
          ? {
              name: "Probe",
              type: "player",
              fields: { hp: 8, mp: 4 },
              version: 6,
              description: "",
            }
          : operation === "replace"
            ? {
                name: "Replacement",
                type: "npc",
                fields: { luck: 2, hp: 9 },
                version: 2,
              }
            : {
                ...(operation === "null" ? {} : { fields: ["marker"] }),
                version: 5,
                description: "",
              },
      );
      if (operation === "null") {
        expect(before.fields).toBeUndefined();
        expect(after.fields).toBeUndefined();
      }
    },
  );

  it("buffers plugin-data writes, deletes, and character upserts", async () => {
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
    await trusted.deletePluginData(
      "other-session",
      "other-plugin",
      "schema",
      "obsolete",
    );

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

    // The buffer holds four proposals, source-bound to the runtime. The delete
    // cannot use the caller-supplied session/plugin ids to escape its scope.
    expect(buffer.map((p) => p.type)).toEqual([
      "plugin.data",
      "plugin.data.batch",
      "character.upsert",
      "plugin.data.delete",
    ]);
    expect(buffer.every((p) => p.source.pluginId === CTX.pluginId)).toBe(true);
    expect(buffer.every((p) => p.sessionId === CTX.sessionId)).toBe(true);
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

  it("rejects missing execution ownership instead of falling back to immediate writes", () => {
    expect(() =>
      Reflect.apply(createTrustedHandlerStore, undefined, [
        createMemoryStore(),
      ]),
    ).toThrow(/execution context and write buffer/);
  });

  it("keeps buffered and committed NUL-containing plugin-data tuples distinct", async () => {
    const store = createMemoryStore();
    const buffer = createExecutionWriteBuffer();
    const trusted = createTrustedHandlerStore(store, CTX, buffer);
    const now = new Date().toISOString();
    const rows = [
      { namespace: "a", key: "b\u0000c", value: "first" },
      { namespace: "a\u0000b", key: "c", value: "second" },
    ].map((entry, index) => ({
      ...entry,
      id: `pd-${index}`,
      sessionId: CTX.sessionId,
      pluginId: CTX.pluginId,
      createdAt: now,
      updatedAt: now,
    }));

    await trusted.setPluginDataBatch(rows);
    expect(
      await trusted.listPluginData(CTX.sessionId, CTX.pluginId),
    ).toMatchObject(
      rows.map(({ namespace, key, value }) => ({ namespace, key, value })),
    );

    await store.setPluginDataBatch(rows);
    buffer.length = 0;
    await trusted.deletePluginData(
      CTX.sessionId,
      CTX.pluginId,
      "a\u0000b",
      "c",
    );
    expect(await trusted.listPluginData(CTX.sessionId, CTX.pluginId)).toEqual([
      rows[0],
    ]);
    expect(await store.listPluginData(CTX.sessionId, CTX.pluginId)).toEqual(
      rows,
    );
  });
});

describe("createPluginDataWriter with a write buffer", () => {
  it("buffers writes and deletes with a read-through overlay", async () => {
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

    // Deletes must stay inside the execution transaction too.
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
    expect(buffer.map((proposal) => proposal.type)).toEqual([
      "plugin.data",
      "plugin.data.delete",
    ]);
    expect(
      await store.getPluginData(
        CTX.sessionId,
        CTX.pluginId,
        "generated",
        "img-2",
      ),
    ).not.toBeNull();
    expect(await writer.get("generated", "img-2")).toBeNull();
    expect(await writer.list("generated")).toEqual([
      { key: "img-1", value: { url: "a" } },
    ]);

    await writer.delete("generated", "img-1");
    expect(await writer.get("generated", "img-1")).toBeNull();
    expect(await writer.list("generated")).toEqual([]);

    await writer.set("generated", "img-2", { restored: true });
    expect(await writer.get("generated", "img-2")).toEqual({
      restored: true,
    });
    expect(await writer.list("generated")).toEqual([
      { key: "img-2", value: { restored: true } },
    ]);

    await writer.set("generated", "img-2", null);
    expect(await writer.get("generated", "img-2")).toBeNull();
    expect(await writer.list("generated")).toEqual([]);
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
