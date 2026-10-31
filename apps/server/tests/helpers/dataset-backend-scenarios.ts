import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import type { DataStore } from "@covel/store";
import { createRpcHandlerStoreView } from "@covel/runtime";
import { capturePluginDatasetPolicy } from "../../src/lib/plugin-dataset-policy.js";
import { applyPreparedWorldDataImportForSession } from "../../src/world-data/session-import.js";
import { datasetWriteFixture } from "./dataset-write-fixture.js";

export async function datasetBackendScenario(store: DataStore) {
  const fixture = await datasetWriteFixture();
  try {
    fixture.policy(["inc"]);
    await expect(fixture.create(store)).rejects.toThrow(
      "operation kind set is not allowed",
    );
    expect(await store.getSession(fixture.options.sessionId)).toBeNull();
    expect(await fixture.rows(store)).toEqual([]);
    expect(
      await store.getCharacterSchema(fixture.options.sessionId),
    ).toBeNull();
    expect(await store.listCharacters(fixture.options.sessionId)).toEqual([]);
    expect(
      await store.listSessionLorebookEntries(fixture.options.sessionId),
    ).toEqual([]);
    expect(
      await store.listWorldDataImportLedger(fixture.options.sessionId),
    ).toEqual([]);

    fixture.policy(["set"]);
    await fixture.create(store);
    const original = await fixture.rows(store);
    const ledger = await store.listWorldDataImportLedger(
      fixture.options.sessionId,
    );
    const prepared = await fixture.prepare();
    if (!prepared.imported) throw new Error("Expected prepared import");
    const tampered = {
      ...prepared,
      diagnostics: [],
      plan: {
        ...prepared.plan,
        diagnostics: [],
        writes: prepared.plan.writes.map((write) =>
          write.kind === "plugin-data"
            ? { ...write, value: { id: write.key, text: 42 } }
            : write,
        ),
      },
    };
    await expect(
      store.withTransaction((tx) =>
        applyPreparedWorldDataImportForSession({
          store: tx,
          ...fixture.options,
          prepared: tampered,
        }),
      ),
    ).rejects.toThrow("record does not match");
    expect(await fixture.rows(store)).toEqual(original);
    expect(
      await store.listWorldDataImportLedger(fixture.options.sessionId),
    ).toEqual(ledger);

    await fixture.records([
      { id: "a", text: "replacement" },
      { id: "b", text: "before" },
    ]);
    expect(await fixture.sync(store)).toMatchObject({
      upserted: 2,
      deleted: 0,
      diagnostics: [],
    });
    expect(
      (await fixture.rows(store)).find((row) => row.key === "a")?.value,
    ).toEqual({ id: "a", text: "replacement" });
    const beforeRemoval = await fixture.rows(store);
    const beforeLedger = await store.listWorldDataImportLedger(
      fixture.options.sessionId,
    );
    await fixture.records([{ id: "a", text: "next" }]);
    for (const dryRun of [true, false]) {
      const refused = await fixture.sync(store, { force: true, dryRun });
      expect(refused).toMatchObject({ upserted: 0, deleted: 0 });
      expect(refused.diagnostics).toEqual([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining(
            "operation kind delete is not allowed",
          ),
        }),
      ]);
      expect(await fixture.rows(store)).toEqual(beforeRemoval);
      expect(
        await store.listWorldDataImportLedger(fixture.options.sessionId),
      ).toEqual(beforeLedger);
    }
    fixture.policy(["set", "delete"]);
    const beforeCharacters = await store.listCharacters(
      fixture.options.sessionId,
    );
    const beforeLorebook = await store.listSessionLorebookEntries(
      fixture.options.sessionId,
    );
    await writeFile(
      path.join(fixture.worldRoot, "characters/characters.json"),
      JSON.stringify([{ id: "hero", name: "Changed hero", type: "npc" }]),
    );
    await writeFile(
      path.join(fixture.worldRoot, "data/lorebook.yaml"),
      "- id: lore\n  content: Changed lore.\n",
    );
    // Fail after valid target mutations, proving rollback rather than admission only.
    const transaction = store.withTransaction.bind(store);
    const injected = vi.spyOn(store, "withTransaction").mockImplementation(
      (body) =>
        transaction((tx) =>
          body(
            new Proxy(tx, {
              get(target, property) {
                if (property === "saveWorldDataImportLedgerBatch")
                  return async () => {
                    throw new Error("ledger publication failed");
                  };
                const value: unknown = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        ) as ReturnType<DataStore["withTransaction"]>,
    );
    await expect(fixture.sync(store)).rejects.toThrow(
      "ledger publication failed",
    );
    injected.mockRestore();
    expect(await store.listCharacters(fixture.options.sessionId)).toEqual(
      beforeCharacters,
    );
    expect(
      await store.listSessionLorebookEntries(fixture.options.sessionId),
    ).toEqual(beforeLorebook);
    expect(await fixture.rows(store)).toEqual(beforeRemoval);
    expect(
      await store.listWorldDataImportLedger(fixture.options.sessionId),
    ).toEqual(beforeLedger);
    expect(await fixture.sync(store)).toMatchObject({
      upserted: 3,
      deleted: 1,
      diagnostics: [],
    });
    expect((await fixture.rows(store)).map((row) => row.key)).toEqual(["a"]);

    const rpc = createRpcHandlerStoreView(
      store,
      { sessionId: fixture.options.sessionId, pluginId: "probe" },
      {
        datasetPolicy: capturePluginDatasetPolicy(
          fixture.registry.getAll().values(),
        ),
      },
    );
    await rpc.setPluginData!({
      namespace: "notes",
      key: "rpc-first",
      value: { id: "rpc-first", text: "valid" },
    });
    await expect(
      rpc.setPluginData!({
        namespace: "notes",
        key: "rpc-second",
        value: { id: "rpc-second", text: 2 },
      }),
    ).rejects.toThrow("record does not match");
    expect(
      (await fixture.rows(store)).some((row) => row.key === "rpc-first"),
    ).toBe(true);
    expect(
      (await fixture.rows(store)).some((row) => row.key === "rpc-second"),
    ).toBe(false);
    await rpc.setPluginData!({
      namespace: "notes",
      key: "rpc-second",
      value: { id: "rpc-second", text: "valid" },
    });
    expect(
      (await fixture.rows(store)).filter((row) => row.key === "rpc-second"),
    ).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}
