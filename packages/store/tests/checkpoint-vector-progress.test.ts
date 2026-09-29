import { expect, it } from "vitest";
import { createMemoryStore } from "../src/memory-entry.js";
import {
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
} from "../src/session-entry.js";
import { makeSession } from "../src/contract/test-fixtures.js";

it("keeps derived index progress out of checkpoints and clears it on replacement", async () => {
  const store = createMemoryStore();
  const session = makeSession({ id: "session", worldId: undefined });
  await store.createSession(session);
  const scope = {
    sessionId: session.id,
    pluginId: "index-owner",
    namespace: "recall",
  };
  await store.compareAndSetVectorIndexProgress({
    ...scope,
    value: "cursor",
    expectedValue: null,
    expectedSessionCreatedAt: session.createdAt,
  });
  await store.setPluginData({
    id: "domain",
    sessionId: session.id,
    pluginId: "domain-plugin",
    namespace: "recall",
    key: "cursor",
    value: "domain-value",
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
  });
  const checkpoint = await exportSessionCheckpoint(store, session.id, {
    revision: 1,
    actionId: "export",
  });
  expect(checkpoint.pluginData.map((row) => row.pluginId)).toEqual([
    "domain-plugin",
  ]);
  expect(JSON.stringify(checkpoint)).not.toContain("index-owner");
  await replaceSessionFromCheckpoint(store, checkpoint);
  expect(await store.getVectorIndexProgress(scope)).toBeNull();
  expect(
    (await store.listPluginDataSessionScope(session.id)).map(
      (row) => row.pluginId,
    ),
  ).toEqual(["domain-plugin"]);
  await store.close();
});
