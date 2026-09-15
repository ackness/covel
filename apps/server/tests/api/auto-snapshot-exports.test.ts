import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeExecution, saveAutoSnapshot } from "@covel/runtime";
import {
  createMemoryStore,
  createSqliteStore,
  type DataStore,
} from "@covel/store";
import { makeSession } from "../../../../packages/store/src/contract/test-fixtures.js";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";

afterEach(() => vi.useRealTimers());

describe.each(["memory", "sqlite"])(
  "auto snapshot export cutoff on %s",
  (backend) => {
    it("includes the committed turn and excludes later exports, even for callers with an old result timestamp", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const resultAt = "2026-01-01T00:00:00.000Z";
      vi.setSystemTime(resultAt);
      const store =
        backend === "sqlite"
          ? createSqliteStore(":memory:")
          : createMemoryStore();
      try {
        await store.createSession(makeSession({ id: "parent" }));
        async function publish(threshold: number) {
          const outcome = await finalizeExecution({
            executionContext: {
              executionId: randomUUID(),
              origin: "manual",
              countPolicy: "none",
            },
            store,
            sessionId: "parent",
            runtimes: [
              {
                name: "producer/config",
                pluginId: "producer",
                version: "1.0.0",
                outputKind: "plugin",
                capabilities: [],
                output: { recordAs: "config", schema: "./output.json" },
              },
            ],
            results: [
              {
                pluginId: "producer",
                runtimeId: "producer/config",
                runId: randomUUID(),
                turnId: "turn",
                status: "success",
                output: { threshold },
                toolCalls: [],
                durationMs: 1,
                timestamp: resultAt,
              },
            ],
            turnIds: [],
            loadOutputSchema: async () => ({
              type: "object",
              required: ["threshold"],
              properties: { threshold: { type: "number" } },
            }),
          });
          expect(outcome.status).toBe("committed");
        }
        vi.setSystemTime("2026-01-01T00:00:00.010Z");
        await publish(7);
        // Older JavaScript callers can still send this removed option. It must
        // not backdate a post-commit capture to the result production time.
        const options = {
          store,
          sessionId: "parent",
          turnId: "turn",
          createdAt: resultAt,
          force: true,
        };
        const snapshot = await saveAutoSnapshot(options);
        expect(snapshot!.createdAt).toBe("2026-01-01T00:00:00.010Z");
        vi.setSystemTime("2026-01-01T00:00:00.020Z");
        await publish(9);
        const app = new Hono<{
          Variables: { store: DataStore; sessionLock: SessionLock };
        }>();
        const sessionLock = createInProcessSessionLock();
        app.use("*", async (c, next) => {
          c.set("store", store);
          c.set("sessionLock", sessionLock);
          await next();
        });
        app.route("/api/sessions", snapshotRoutes);
        const response = await app.request("/api/sessions/parent/fork", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromSnapshotId: snapshot!.id }),
        });
        expect(response.status).toBe(201);
        const child = (await response.json()) as { sessionId: string };
        const exports = await store.listRuntimeExports(child.sessionId);
        expect(exports).toHaveLength(1);
        expect(exports[0]).toMatchObject({
          revision: 1,
          value: { threshold: 7 },
        });
        expect(await store.listRuntimeExports("parent")).toHaveLength(2);
      } finally {
        await store.close();
      }
    });
  },
);
