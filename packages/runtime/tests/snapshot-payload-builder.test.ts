import { expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  makeSession,
  makeSessionSummary,
  makeSnapshot,
  makeTurnMessage,
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
    (await store.getSnapshot(snapshot.id))?.payload.pluginData[0]!.value,
  ).toStrictEqual({
    text: "",
    nullable: null,
    nested: { kept: 1 },
  });
  expect(
    (await store.listPluginDataSessionScope("sess-1"))[0]!.value,
  ).toStrictEqual(value);
});

it("records the cursor and compaction tags without reading the model history", async () => {
  const store = createMemoryStore();
  await store.createSession(makeSession({ id: "sess-1" }));
  await store.saveSessionSummary(
    makeSessionSummary({ id: "summary-1", sessionId: "sess-1" }),
  );
  await store.saveSessionSummary(
    makeSessionSummary({ id: "summary-unused", sessionId: "sess-1" }),
  );
  const at = (second: number) => `2026-09-19T00:00:0${second}.000Z`;
  await store.appendTurnMessage(
    makeTurnMessage({
      id: "old",
      createdAt: at(1),
      compactedAtTurnId: "summary-1",
    }),
  );
  await store.appendTurnMessage(
    makeTurnMessage({ id: "last", createdAt: at(3) }),
  );
  await store.appendTurnMessage(
    makeTurnMessage({ id: "mid", createdAt: at(2) }),
  );
  const fullRead = vi.spyOn(store, "listTurnMessages");

  const payload = await buildSnapshotPayload(store, "sess-1", "turn");

  expect(fullRead).not.toHaveBeenCalled();
  expect(payload.messagesCursor).toBe("last");
  expect(payload.compactedMessageSummaryIds).toEqual({ old: "summary-1" });
  expect(payload.sessionSummaries.map((summary) => summary.id)).toEqual([
    "summary-1",
  ]);

  await store.tagTurnMessagesCompacted("sess-1", ["mid"], "summary-gone");
  await expect(buildSnapshotPayload(store, "sess-1", "turn")).rejects.toThrow(
    "summary-gone",
  );
});
