/**
 * Contract suite for JSON columns holding a bare string whose text is itself
 * JSON (`"30"`, `"true"`, `"null"`, …). A backend must hand back the string it
 * stored, not the value that string spells.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { DataStore } from "../../types.js";
import {
  makeEvent,
  makeJobStatus,
  makeMessage,
  makeRuntimeExport,
  makeSession,
  makeSnapshot,
  makeSnapshotPayload,
  makeStateChange,
  makeStateEntry,
  makeTraceEvent,
  ts,
} from "../test-fixtures.js";

const JSON_LOOKING_STRINGS = [
  "30",
  "true",
  "null",
  "[1]",
  '{"a":1}',
  '"quoted"',
  "plain text",
  "",
] as const;

export function registerJsonStringStoreSuite(getStore: () => DataStore): void {
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  describe("JSON columns keep a string that spells JSON", () => {
    const sessionId = "sess-json-str";

    beforeEach(async () => {
      await store.createSession(makeSession({ id: sessionId }));
    });

    it("plugin data value", async () => {
      for (const [i, value] of JSON_LOOKING_STRINGS.entries()) {
        await store.setPluginData({
          id: `pd-${i}`,
          sessionId,
          pluginId: "owner",
          namespace: "ns",
          key: `k${i}`,
          value,
          createdAt: ts(),
          updatedAt: ts(),
        });
        const row = await store.getPluginData(
          sessionId,
          "owner",
          "ns",
          `k${i}`,
        );
        expect(row?.value, JSON.stringify(value)).toBe(value);
      }
    });

    it("state entry and state change value", async () => {
      for (const [i, value] of JSON_LOOKING_STRINGS.entries()) {
        await store.upsertStateEntry(
          makeStateEntry({
            sessionId,
            tableName: "t",
            fieldName: `f${i}`,
            value,
          }),
        );
        const entry = await store.getStateEntry(sessionId, "t", `f${i}`);
        expect(entry?.value, JSON.stringify(value)).toBe(value);
        await store.addStateChange(
          makeStateChange({
            sessionId,
            tableName: "t",
            fieldName: `c${i}`,
            value,
          }),
        );
        const [change] = await store.listStateChanges(sessionId, "t", `c${i}`);
        expect(change?.value, JSON.stringify(value)).toBe(value);
      }
    });

    it("event payload and message metadata", async () => {
      for (const [i, value] of JSON_LOOKING_STRINGS.entries()) {
        await store.saveEvent(
          makeEvent({ id: `ev-${i}`, sessionId, topic: "t", payload: value }),
        );
        const event = await store.getEventById(sessionId, `ev-${i}`);
        expect(event?.payload, JSON.stringify(value)).toBe(value);
        await store.addMessage(
          makeMessage({ id: `msg-${i}`, sessionId, metadata: value }),
        );
      }
      const messages = await store.listMessages(sessionId);
      for (const [i, value] of JSON_LOOKING_STRINGS.entries()) {
        const message = messages.find((m) => m.id === `msg-${i}`);
        expect(message?.metadata, JSON.stringify(value)).toBe(value);
      }
    });

    it("trace payload, job status data and runtime export value", async () => {
      for (const [i, value] of JSON_LOOKING_STRINGS.entries()) {
        await store.addTraceEvent(
          makeTraceEvent({ id: `tr-${i}`, sessionId, payload: value }),
        );
        await store.appendJobStatus(
          makeJobStatus({ sessionId, jobId: `job-${i}`, data: value }),
        );
        await store.appendRuntimeExport(
          makeRuntimeExport({
            sessionId,
            recordAs: `export-${i}`,
            value,
          }),
        );
      }
      const traces = await store.listTraceEvents(sessionId);
      const jobs = await store.listJobStatus(sessionId);
      const exports = await store.listRuntimeExports(sessionId);
      for (const [i, value] of JSON_LOOKING_STRINGS.entries()) {
        expect(
          traces.find((t) => t.id === `tr-${i}`)?.payload,
          JSON.stringify(value),
        ).toBe(value);
        expect(
          jobs.find((j) => j.jobId === `job-${i}`)?.data,
          JSON.stringify(value),
        ).toBe(value);
        expect(
          exports.find((e) => e.recordAs === `export-${i}`)?.value,
          JSON.stringify(value),
        ).toBe(value);
      }
    });

    it("values nested in a snapshot payload", async () => {
      const payload = makeSnapshotPayload({
        stateEntries: JSON_LOOKING_STRINGS.map((value, i) =>
          makeStateEntry({ sessionId, fieldName: `f${i}`, value }),
        ),
        pluginData: JSON_LOOKING_STRINGS.map((value, i) => ({
          id: `snap-pd-${i}`,
          sessionId,
          pluginId: "owner",
          namespace: "ns",
          key: `k${i}`,
          value,
          createdAt: ts(),
          updatedAt: ts(),
        })),
      });
      const snapshot = makeSnapshot({ id: "snap-json", sessionId, payload });
      await store.saveSnapshot(snapshot);
      const read = await store.getSnapshot("snap-json");
      expect(read?.payload.stateEntries.map((e) => e.value)).toEqual([
        ...JSON_LOOKING_STRINGS,
      ]);
      expect(read?.payload.pluginData.map((e) => e.value)).toEqual([
        ...JSON_LOOKING_STRINGS,
      ]);
    });
  });
}
