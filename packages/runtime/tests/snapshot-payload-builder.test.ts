import { expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import {
  makeSession,
  makeSnapshot,
} from "../../store/src/contract/test-fixtures.js";
import { buildSnapshotPayload } from "../src/snapshot/snapshot-payload-builder.js";

it("captures JSON-serialized plugin state without changing the live record", async () => {
  const store = createMemoryStore();
  await store.createSession(makeSession({ id: "sess-1" }));
  const value = {
    text: "",
    nullable: null,
    omitted: undefined,
    nested: { kept: 1, omitted: undefined },
  };
  await store.setPluginData({
    id: "plugin-data",
    sessionId: "sess-1",
    pluginId: "fixture",
    namespace: "state",
    key: "state",
    value,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  });
  const payload = await buildSnapshotPayload(store, "sess-1", "turn");
  const snapshot = makeSnapshot({ payload });
  await store.saveSnapshot(snapshot);
  expect(
    (await store.getSnapshot(snapshot.id))?.payload.pluginData[0].value,
  ).toStrictEqual({
    text: "",
    nullable: null,
    nested: { kept: 1 },
  });
  expect(
    (await store.listPluginDataSessionScope("sess-1"))[0].value,
  ).toStrictEqual(value);
});
