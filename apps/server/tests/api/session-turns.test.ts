/**
 * GET /api/sessions/:id/turns — persisted turn artifact listing.
 *
 * Thin route over store.listTurnResults; restored for the e2e-plugin-verify
 * harness which polls it after every action to assert commit outcomes.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { toJsonValueOrDiagnostic } from "@covel/shared";
import { sessionTurnRoutes } from "../../src/routes/api/session-turns.js";

async function makeApp(): Promise<{ app: Hono; store: DataStore }> {
  const store = createMemoryStore();
  const app = new Hono();
  // One registered runtime declares `io.concealed`.
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
  app.use("*", async (c, next) => {
    c.set("store" as never, store as never);
    c.set("pluginRegistry" as never, pluginRegistry as never);
    await next();
  });
  app.route("/api/sessions", sessionTurnRoutes);
  return { app, store };
}

describe("GET /api/sessions/:id/turns", () => {
  it.each(["failed", "success"] as const)(
    "lists %s artifacts while concealing normalized optional-field audit output",
    async (status) => {
      const { app, store } = await makeApp();
      const rawOutput = {
        plan: "spoiler",
        description: undefined,
        imageHint: undefined,
      };
      const auditOutput = toJsonValueOrDiagnostic(rawOutput);
      expect(auditOutput).toEqual({ plan: "spoiler" });
      expect(rawOutput).toHaveProperty("description", undefined);
      await store.createSession({
        phase: "playing",
        setupRuntimes: {},
        seats: [
          {
            id: "main",
            controller: "human",
            role: "player",
            characters: "auto",
          },
        ],
        metadata: {
          approvalScopeNonce: globalThis.crypto.randomUUID(),
          sessionIncarnationNonce: globalThis.crypto.randomUUID(),
        },
        id: "sess-turns",
        status: "active",
        completedPlayerTurns: 1,

        activePlugins: [],
        locale: "zh-CN",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await store.saveTurnResult({
        id: crypto.randomUUID(),
        sessionId: "sess-turns",
        turnId: "turn-1",
        runtimeResults: [
          {
            pluginId: "planner",
            runtimeId: "planner/plot",
            runId: "run-planner",
            turnId: "turn-1",
            status,
            ...(status === "failed" ? { error: "spoiler" } : {}),
            output: auditOutput,
            toolCalls: [
              {
                toolCallId: "call-planner",
                toolName: "plan",
                pluginId: "planner",
                runtimeId: "planner/plot",
                turnId: "turn-1",
                input: { plan: "spoiler" },
                output: auditOutput,
                durationMs: 1,
                approvalStatus: "auto-allowed",
                timestamp: new Date().toISOString(),
              },
            ],
            durationMs: 1,
            timestamp: new Date().toISOString(),
          },
          {
            pluginId: "narrator",
            runtimeId: "narrator",
            runId: "run-narrator",
            turnId: "turn-1",
            status: "success",
            output: auditOutput,
            toolCalls: [
              {
                toolCallId: "call-narrator",
                toolName: "plan",
                pluginId: "narrator",
                runtimeId: "narrator",
                turnId: "turn-1",
                input: { plan: "spoiler" },
                output: auditOutput,
                durationMs: 1,
                approvalStatus: "auto-allowed",
                timestamp: new Date().toISOString(),
              },
            ],
            durationMs: 1,
            timestamp: new Date().toISOString(),
          },
        ],
        origin: "player",
        commitStatus: "committed",
        durationMs: 5,
        createdAt: new Date().toISOString(),
      });

      const res = await app.request("/api/sessions/sess-turns/turns");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ turnId: string; commitStatus: string }>;
      };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        turnId: "turn-1",
        commitStatus: "committed",
      });
      const [concealed, open] = (
        body.items[0] as unknown as {
          runtimeResults: Array<{ output: unknown; toolCalls: unknown[] }>;
        }
      ).runtimeResults;
      expect(JSON.stringify(concealed)).not.toContain("spoiler");
      expect(concealed!.toolCalls).toHaveLength(1);
      expect(concealed!.toolCalls[0]).not.toHaveProperty("output", auditOutput);
      expect(open!.output).toEqual({ plan: "spoiler" });
      expect(open!.toolCalls[0]).toHaveProperty("output", { plan: "spoiler" });
      const stored = await store.listTurnResults("sess-turns");
      expect(stored[0]?.runtimeResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runtimeId: "planner/plot",
            toolCalls: [
              expect.objectContaining({ output: { plan: "spoiler" } }),
            ],
          }),
        ]),
      );
      await store.close();
    },
  );

  it("404s for an unknown session", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/sessions/nope/turns");
    expect(res.status).toBe(404);
  });
});
