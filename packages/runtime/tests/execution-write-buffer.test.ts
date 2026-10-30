/**
 * Effects isolation: function-runtime / agent-guard domain writes buffer
 * into proposals instead of hitting the store directly, and reads overlay the
 * buffer so a handler/guard sees its own not-yet-committed writes. The buffer
 * flushes onto the runtime result, so processRuntimeResult commits it through
 * the normal pipeline — even when the result is a SKIPPED pre-game guard.
 */

import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { Proposal, CharacterUpsertPayload } from "@covel/shared";
import {
  createFunctionStoreView,
  createPluginDataWriter,
  makeRevocableCapability,
} from "../src/function-runtime/plugin-handler-helpers.js";
import { createExecutionWriteBuffer } from "../src/function-runtime/execution-write-buffer.js";
import { createWorldModelView } from "../src/function-runtime/world-model-view.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  prepareRuntimeProposals,
  processRuntimeResult,
} from "../src/session/session-runtime-result.js";

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

describe("buffered writes as a handler reads them", () => {
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
      const world = await createWorldModelView(
        store,
        CTX.sessionId,
        [],
        buffer,
      );
      const before = world.characters[0]!;
      expect(await store.listCharacters(CTX.sessionId)).toEqual([initial]);
      const result = await processRuntimeResult(
        {
          pluginId: CTX.pluginId,
          runtimeId: CTX.runtimeId,
          turnId: CTX.turnId,
          status: "success",
          output: {},
          pendingProposals: buffer,
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

  it("overlays buffered plugin-data writes on the store view", async () => {
    const store = createMemoryStore();
    const buffer = createExecutionWriteBuffer();
    const writer = createPluginDataWriter(store, CTX, buffer);
    const view = createFunctionStoreView(store, CTX, buffer);

    await writer.set("schema", "k", { hi: true });

    expect(
      await store.getPluginData(CTX.sessionId, CTX.pluginId, "schema", "k"),
    ).toBeNull();
    expect((await view.getPluginData("schema", "k"))?.value).toEqual({
      hi: true,
    });
    expect((await view.listPluginData("schema")).map((r) => r.key)).toEqual([
      "k",
    ]);
  });

  it("keeps buffered and committed delimiter-containing plugin-data tuples distinct", async () => {
    const store = createMemoryStore();
    const buffer = createExecutionWriteBuffer();
    const writer = createPluginDataWriter(store, CTX, buffer);
    const view = createFunctionStoreView(store, CTX, buffer);
    const now = new Date().toISOString();
    const rows = [
      { namespace: "a", key: "b:c", value: "first" },
      { namespace: "a:b", key: "c", value: "second" },
    ].map((entry, index) => ({
      ...entry,
      id: `pd-${index}`,
      sessionId: CTX.sessionId,
      pluginId: CTX.pluginId,
      createdAt: now,
      updatedAt: now,
    }));

    for (const row of rows) await writer.set(row.namespace, row.key, row.value);
    expect(await view.listPluginData("a")).toMatchObject([
      { namespace: "a", key: "b:c", value: "first" },
    ]);
    expect(await view.listPluginData("a:b")).toMatchObject([
      { namespace: "a:b", key: "c", value: "second" },
    ]);

    await store.setPluginDataBatch(rows);
    buffer.length = 0;
    await writer.delete("a:b", "c");
    expect(await view.listPluginData("a:b")).toEqual([]);
    expect(await view.listPluginData("a")).toEqual([rows[0]]);
    expect(await store.listPluginData(CTX.sessionId, CTX.pluginId)).toEqual(
      rows,
    );
  });
});

describe("createPluginDataWriter with a write buffer", () => {
  it("preserves committed timestamps across scoped reads and omits them on new buffered rows", async () => {
    const store = createMemoryStore();
    const stored = {
      id: "stored",
      sessionId: CTX.sessionId,
      pluginId: CTX.pluginId,
      namespace: "notes",
      key: "existing",
      value: "before",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    await store.setPluginData(stored);
    const buffer = createExecutionWriteBuffer();
    const writer = createPluginDataWriter(store, CTX, buffer);
    const view = createFunctionStoreView(store, CTX, buffer);
    try {
      await writer.set("notes", "existing", "after");
      await writer.set("notes", "new", "pending");
      const rows = await view.listPluginData("notes");
      for (const row of [
        await view.getPluginData("notes", "existing"),
        rows.find((entry) => entry.key === "existing"),
      ]) {
        expect(row).toMatchObject({
          value: "after",
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
        });
      }
      for (const row of [
        await view.getPluginData("notes", "new"),
        rows.find((entry) => entry.key === "new"),
      ]) {
        expect(row).toMatchObject({ value: "pending" });
        expect(row).not.toHaveProperty("createdAt");
        expect(row).not.toHaveProperty("updatedAt");
      }
      expect(await writer.list("notes")).toEqual([
        {
          key: "existing",
          value: "after",
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
        },
        { key: "new", value: "pending" },
      ]);
      expect(
        await store.listPluginData(CTX.sessionId, CTX.pluginId, "notes"),
      ).toEqual([stored]);
    } finally {
      await store.close();
    }
  });

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
    // Pending-only entries have no stored timestamps.
    expect(list).toEqual([
      {
        key: "img-1",
        value: { url: "a" },
      },
    ]);

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
    expect(await writer.list("generated")).toMatchObject([
      { key: "img-1", value: { url: "a" } },
    ]);

    await writer.delete("generated", "img-1");
    expect(await writer.get("generated", "img-1")).toBeNull();
    expect(await writer.list("generated")).toEqual([]);

    await writer.set("generated", "img-2", { restored: true });
    expect(await writer.get("generated", "img-2")).toEqual({
      restored: true,
    });
    expect(await writer.list("generated")).toMatchObject([
      { key: "img-2", value: { restored: true } },
    ]);

    await writer.set("generated", "img-2", null);
    expect(await writer.get("generated", "img-2")).toBeNull();
    expect(await writer.list("generated")).toEqual([]);
  });
});

describe("createPluginDataWriter.update", () => {
  const seed = async (
    store: ReturnType<typeof createMemoryStore>,
    key: string,
    value: unknown,
  ) => {
    const now = new Date().toISOString();
    await store.setPluginData({
      id: `row-${key}`,
      sessionId: CTX.sessionId,
      pluginId: CTX.pluginId,
      namespace: "wallet",
      key,
      value,
      createdAt: now,
      updatedAt: now,
    });
  };
  const storedValue = async (
    store: ReturnType<typeof createMemoryStore>,
    key: string,
  ) =>
    (await store.getPluginData(CTX.sessionId, CTX.pluginId, "wallet", key))
      ?.value;

  it("buffers one plugin.data.update and every read projects it over the stored row", async () => {
    const store = createMemoryStore();
    await seed(store, "gold", { coins: 10, log: ["start"] });
    const buffer = createExecutionWriteBuffer();
    const writer = createPluginDataWriter(store, CTX, buffer);
    const view = createFunctionStoreView(store, CTX, buffer);

    await writer.update("wallet", "gold", [
      { op: "inc", path: "/coins", by: -3, min: 0 },
      { op: "append", path: "/log", value: "spent" },
    ]);
    expect(buffer).toEqual([
      expect.objectContaining({
        type: "plugin.data.update",
        source: { pluginId: CTX.pluginId, runtimeId: CTX.runtimeId },
        payload: {
          namespace: "wallet",
          key: "gold",
          ops: [
            { op: "inc", path: "/coins", by: -3, min: 0 },
            { op: "append", path: "/log", value: "spent" },
          ],
        },
      }),
    ]);
    const projected = { coins: 7, log: ["start", "spent"] };
    expect(await storedValue(store, "gold")).toEqual({
      coins: 10,
      log: ["start"],
    });
    expect(await writer.get("wallet", "gold")).toEqual(projected);
    expect(await writer.list("wallet")).toMatchObject([
      { key: "gold", value: projected },
    ]);
    expect(await view.getPluginData("wallet", "gold")).toMatchObject({
      id: "row-gold",
      value: projected,
    });
    expect(await view.listPluginData("wallet")).toMatchObject([
      { id: "row-gold", key: "gold", value: projected },
    ]);

    // A second update reads the first one's projection.
    await writer.update("wallet", "gold", [
      { op: "inc", path: "/coins", by: -7, min: 0 },
    ]);
    expect(await writer.get("wallet", "gold")).toMatchObject({ coins: 0 });

    // An update ending absent reads as deleted.
    await writer.update("wallet", "gold", [{ op: "delete" }]);
    expect(await writer.get("wallet", "gold")).toBeNull();
    expect(await view.getPluginData("wallet", "gold")).toBeNull();
    expect(await writer.list("wallet")).toEqual([]);
  });

  it("throws on ops that fail against the current view and buffers nothing", async () => {
    const store = createMemoryStore();
    await seed(store, "gold", 2);
    const buffer = createExecutionWriteBuffer();
    const writer = createPluginDataWriter(store, CTX, buffer);
    await expect(
      writer.update("wallet", "gold", [{ op: "inc", by: -3, min: 0 }]),
    ).rejects.toThrow(
      /^pluginData\.update: inc result is outside the allowed range$/,
    );
    expect(buffer).toEqual([]);
  });

  it("throws a TypeError for invalid ops", async () => {
    const store = createMemoryStore();
    const buffer = createExecutionWriteBuffer();
    const writer = createPluginDataWriter(store, CTX, buffer);
    for (const ops of [[], [{ op: "swap" }], "inc", [{ op: "inc", by: NaN }]])
      await expect(
        writer.update("wallet", "gold", ops as never),
      ).rejects.toThrow(
        expect.objectContaining({
          name: "TypeError",
          message: expect.stringMatching(/^pluginData\.update: invalid ops \(/),
        }),
      );
    expect(buffer).toEqual([]);
  });

  it("throws for a reserved namespace and an oversized result", async () => {
    const store = createMemoryStore();
    const buffer = createExecutionWriteBuffer();
    const writer = createPluginDataWriter(store, CTX, buffer);
    await expect(
      writer.update("_logs", "k", [{ op: "set", value: 1 }]),
    ).rejects.toThrow(/_logs/);
    await seed(store, "big", ["x".repeat(200 * 1024)]);
    await expect(
      writer.update("wallet", "big", [
        { op: "append", value: "y".repeat(60 * 1024) },
      ]),
    ).rejects.toThrow(/byte limit/);
    expect(buffer).toEqual([]);
    await writer.update("_hidden.state", "k", [{ op: "inc", by: 1 }]);
    expect(buffer).toHaveLength(1);
  });

  it("writes directly without a buffer", async () => {
    const store = createMemoryStore();
    await seed(store, "gold", 4);
    const writer = createPluginDataWriter(store, CTX);
    await writer.update("wallet", "gold", [{ op: "inc", by: 1 }]);
    expect(await storedValue(store, "gold")).toBe(5);
    await writer.update("wallet", "gold", [{ op: "delete" }]);
    expect(await storedValue(store, "gold")).toBeUndefined();
    await writer.update("wallet", "fresh", [{ op: "append", value: 1 }]);
    expect(await storedValue(store, "fresh")).toEqual([1]);
  });

  it("is revoked with the rest of the writer", async () => {
    const store = createMemoryStore();
    let revoked = false;
    const writer = makeRevocableCapability(
      createPluginDataWriter(store, CTX, createExecutionWriteBuffer()),
      () => revoked,
      "pluginData",
    );
    await writer.update("wallet", "gold", [{ op: "inc", by: 1 }]);
    revoked = true;
    expect(() =>
      writer.update("wallet", "gold", [{ op: "inc", by: 1 }]),
    ).toThrow(/capability "pluginData\.update" is revoked/);
  });
});

describe("processRuntimeResult and non-success results", () => {
  it("commits a skipped pre-game guard's buffered writes", async () => {
    const store = createMemoryStore();
    const output: Record<string, unknown> = { skip: true, preGameDone: true };

    const out = await processRuntimeResult(
      {
        pluginId: CTX.pluginId,
        runtimeId: CTX.runtimeId,
        turnId: CTX.turnId,
        status: "skipped",
        output,
        pendingProposals: [pluginDataProposal()],
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

    await processRuntimeResult(
      {
        pluginId: CTX.pluginId,
        runtimeId: CTX.runtimeId,
        turnId: CTX.turnId,
        status: "failed",
        output,
        pendingProposals: [pluginDataProposal()],
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

describe("prepareRuntimeProposals with a proposal guard", () => {
  it("checks the payload a PreStateCommit hook put in place", async () => {
    const hookPipeline = createHookPipeline();
    hookPipeline.register<{ proposal: Proposal }>({
      id: "move",
      event: "PreStateCommit",
      async handler(_ctx, payload) {
        return {
          action: "continue",
          replace: {
            proposal: {
              ...payload.proposal,
              payload: { ...payload.proposal.payload, namespace: "other" },
            } as Proposal,
          },
        };
      },
    });

    const prepared = await prepareRuntimeProposals(
      {
        pluginId: CTX.pluginId,
        runtimeId: CTX.runtimeId,
        turnId: CTX.turnId,
        status: "success",
        output: {},
        pendingProposals: [pluginDataProposal()],
      },
      createMemoryStore(),
      CTX.sessionId,
      "system",
      {
        hookPipeline,
        proposalGuard: (proposal) =>
          proposal.type === "plugin.data" &&
          proposal.payload.namespace !== "schema"
            ? "undeclared namespace"
            : undefined,
      },
    );

    expect(prepared.proposals).toEqual([]);
    expect(prepared.failedProposals.map((failed) => failed.error)).toEqual([
      "undeclared namespace",
    ]);
  });
});
