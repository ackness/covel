/**
 * GET /api/sessions/:id/snapshots/:snapshotId answers with the player-facing
 * view: hidden world data, concealed runtimes' exports and suspension
 * continuations stay in the stored snapshot (fork and restore need them) but
 * never leave in the response.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  makeRuntimeExport,
  makeSession,
  makeSnapshot,
  makeSnapshotPayload,
  makeSuspension,
  makeWorld,
} from "../../../../packages/store/src/contract/test-fixtures.js";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

const now = "2026-10-09T00:00:00.000Z";

function pluginRow(namespace: string, key: string, value: unknown) {
  return {
    id: `${namespace}-${key}`,
    sessionId: "sess-1",
    pluginId: "test-plugin",
    namespace,
    key,
    value,
    createdAt: now,
    updatedAt: now,
  };
}

describe("snapshot read endpoint", () => {
  it("withholds hidden data, concealed exports and continuations from the response only", async () => {
    const store = createMemoryStore();
    await store.createWorld(makeWorld({ id: "world-1" }));
    await store.createSession(
      makeSession({
        id: "sess-1",
        metadata: { sessionIncarnationNonce: crypto.randomUUID() },
      }),
    );
    const suspension = makeSuspension({ sessionId: "sess-1" });
    await store.saveSuspension(suspension);
    const snapshot = makeSnapshot({
      sessionId: "sess-1",
      payload: makeSnapshotPayload({
        pluginData: [
          pluginRow("_hidden.events", "secret", { brief: "HIDDEN-BRIEF" }),
          pluginRow("notes", "open", { text: "visible" }),
        ],
        runtimeExports: [
          makeRuntimeExport({
            sessionId: "sess-1",
            producerRuntimeId: "planner/plot",
            value: { plan: "CONCEALED-PLAN" },
          }),
          makeRuntimeExport({
            sessionId: "sess-1",
            producerRuntimeId: "world-init/schema-gen",
          }),
        ],
        suspensions: [suspension],
      }),
    });
    await store.saveSnapshot(snapshot);

    const pluginRegistry = {
      getAll: () =>
        new Map([
          [
            "planner",
            {
              manifests: [
                { manifest: { name: "planner/plot", concealed: true } },
              ],
            },
          ],
        ]),
    };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store" as never, store as DataStore as never);
      c.set("sessionLock" as never, createInProcessSessionLock() as never);
      c.set("pluginRegistry" as never, pluginRegistry as never);
      await next();
    });
    app.route("/api/sessions", snapshotRoutes);

    const res = await app.request(
      `/api/sessions/sess-1/snapshots/${snapshot.id}`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("HIDDEN-BRIEF");
    expect(text).not.toContain("CONCEALED-PLAN");
    expect(text).not.toContain("You are a test assistant.");
    const body = JSON.parse(text) as {
      payload: {
        pluginData: { key: string }[];
        runtimeExports: { producerRuntimeId: string }[];
        suspensions: { id: string; reason: string }[];
      };
    };
    expect(body.payload.pluginData.map((row) => row.key)).toEqual(["open"]);
    expect(body.payload.runtimeExports.map((r) => r.producerRuntimeId)).toEqual(
      ["world-init/schema-gen"],
    );
    expect(body.payload.suspensions).toEqual([
      expect.objectContaining({ id: suspension.id, reason: suspension.reason }),
    ]);

    // The stored snapshot is untouched.
    const stored = await store.getSnapshot(snapshot.id);
    expect(stored?.payload.pluginData).toHaveLength(2);
    expect(stored?.payload.runtimeExports).toHaveLength(2);
    expect(
      stored?.payload.suspensions[0]?.pendingContinuation.messages,
    ).not.toEqual([]);
  });
});
