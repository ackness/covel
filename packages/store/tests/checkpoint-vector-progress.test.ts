import { expect, it } from "vitest";
import {
  createMemoryStore,
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
} from "../src/index.js";
import { MEMORY_VECTOR_PLUGIN_ID } from "../src/vector-store.js";
import { makeSession } from "../src/contract/test-fixtures.js";

it("invalidates only owned physical-index progress when checkpoint replaces a session", async () => {
  const store = createMemoryStore();
  const session = makeSession({ id: "session", worldId: undefined });
  await store.createSession(session);
  for (const pluginId of [MEMORY_VECTOR_PLUGIN_ID, "domain-plugin"]) {
    await store.setPluginData({
      id: pluginId,
      sessionId: session.id,
      pluginId,
      namespace: "recall-ingest",
      key: "cursor",
      value: { id: "old", createdAt: session.createdAt },
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
    });
  }
  const all = await store.listPluginDataSessionScope(session.id);
  const checkpoint = await exportSessionCheckpoint(store, session.id, {
    revision: 1,
    actionId: "export",
  });
  expect(checkpoint.pluginData.map((row) => row.pluginId)).toEqual([
    "domain-plugin",
  ]);
  await replaceSessionFromCheckpoint(store, { ...checkpoint, pluginData: all });
  expect(
    (await store.listPluginDataSessionScope(session.id)).map(
      (row) => row.pluginId,
    ),
  ).toEqual(["domain-plugin"]);
  await store.close();
});
