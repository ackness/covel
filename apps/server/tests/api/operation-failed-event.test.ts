import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createHookPipeline } from "@covel/runtime";
import {
  defaultSessionSeats,
  type LLMAdapter,
  type Proposal,
} from "@covel/shared";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
afterEach(() => vi.unstubAllEnvs());

describe("committed operation failure event", () => {
  it.each([false, true])(
    "streams a fixed notice and preserves the story across advancement (%s)",
    async (advance) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "covel-operation-notice-"),
      );
      const store = createMemoryStore();
      let boot: ApiBootstrapResult | undefined;
      try {
        const builtin = path.join(root, "builtin");
        const user = path.join(root, "user");
        await mkdir(user);
        await mkdir(path.join(builtin, "caller"), { recursive: true });
        await mkdir(path.join(builtin, "provider"));
        await writeFile(
          path.join(builtin, "caller", "PLUGIN.md"),
          `---
id: caller
kind: plugin
description: Story caller
runtime:
  schedule: { stage: narrative }
  io: { visibility: story, output: { contract: narrative-engine@2 } }
  agent:
    tools:
      services: [{ contract: change@1, as: change }]
---
Tell the story.
`,
        );
        await writeFile(
          path.join(builtin, "provider", "PLUGIN.md"),
          `---
id: provider
kind: plugin
description: Change provider
entry: ./entry.mjs
contributes:
  services: [{ contract: change@1, access: write, modelFacing: true }]
---
`,
        );
        await writeFile(
          path.join(builtin, "provider", "entry.mjs"),
          `export default function (api) {
  const z = api.toolkit.z;
  api.registerService({ name: "change", contract: "change@1", access: "write", modelFacing: true, description: "Record a change", input: z.object({ key: z.string() }), output: z.unknown(), handler: async ({ key }, ctx) => { await ctx.pluginData.set("values", key, true); return { key }; } });
}
`,
        );
        vi.stubEnv("COVEL_USER_PLUGINS_DIR", user);
        vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-operation-token");
        vi.stubEnv("NODE_ENV", "production");
        const now = new Date().toISOString();
        await store.createSession({
          id: "session",
          status: "active",
          phase: "playing",
          setupRuntimes: {},
          seats: defaultSessionSeats(),
          completedPlayerTurns: 0,
          activePlugins: ["caller", "provider"],
          locale: "en-US",
          metadata: {
            approvalScopeNonce: crypto.randomUUID(),
            sessionIncarnationNonce: crypto.randomUUID(),
          },
          createdAt: now,
          updatedAt: now,
        });
        const hooks = createHookPipeline();
        hooks.register<{ proposal: Proposal }>({
          id: "reject-change",
          pluginId: "provider",
          event: "PreStateCommit",
          handler: async (_ctx, payload) =>
            "key" in payload.proposal.payload &&
            payload.proposal.payload.key === "rejected"
              ? { action: "abort", reason: "The change is refused." }
              : { action: "continue" },
        });
        let calls = 0;
        const contexts: string[] = [];
        const generate: LLMAdapter["generate"] = async (request) => {
          contexts.push(JSON.stringify(request.messages));
          const index = calls++;
          return {
            content:
              index < 2
                ? null
                : JSON.stringify({
                    segments: [
                      { kind: "narration", text: "The story continues." },
                    ],
                    yield: advance && index === 2 ? "continue" : "user",
                  }),
            toolCalls:
              index < 2
                ? [
                    {
                      id: `call-${index}`,
                      name: "change",
                      arguments: JSON.stringify({
                        key: index === 0 ? "kept" : "rejected",
                      }),
                    },
                  ]
                : [],
            finishReason: index < 2 ? "tool_calls" : "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        };
        boot = await bootstrapApi({
          pluginsDir: builtin,
          pluginsDirs: [builtin, user],
          store,
          storeBackend: "memory",
          llmAdapter: { generate },
          perRequestMiddleware: [
            async (c, next) => {
              c.set("hookPipeline", hooks);
              await next();
            },
          ],
        });
        const act = async () => {
          const response = await boot!.app.request("/api/actions", {
            method: "POST",
            headers: {
              Authorization: "Bearer synthetic-operation-token",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              sessionId: "session",
              type: "submit_actions",
              payload: { actions: [{ kind: "say", text: "Continue" }] },
            }),
          });
          const body = await response.text();
          expect(response.status, body).toBe(200);
          return body
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map(
              (line) =>
                JSON.parse(line.slice(6)) as {
                  type: string;
                  turnId: string;
                  payload: Record<string, unknown>;
                },
            );
        };
        const events = await act();
        expect(
          events.filter((event) => event.type === "execution.started"),
        ).toHaveLength(advance ? 2 : 1);
        expect(
          events.filter((event) => event.type === "execution.completed"),
        ).toHaveLength(1);
        if (advance) expect(contexts[3]).toContain("operations-not-applied");
        const failed = events.filter(
          (event) => event.type === "operation.failed",
        );
        expect(failed).toHaveLength(1);
        expect(failed[0]?.payload).toMatchObject({
          sessionId: "session",
          turnId: failed[0]?.turnId,
          count: 1,
        });
        expect(
          events.find((event) => event.type === "execution.completed")?.payload,
        ).toMatchObject({ committed: true });
        // The notice is the only failure the player hears of: the rejected
        // write of the operation is not an execution failure.
        expect(
          events.filter((event) => event.type === "proposal.failed"),
        ).toEqual([]);
        expect(
          events.findIndex((event) => event.type === "operation.failed"),
        ).toBeLessThan(
          events.findIndex((event) => event.type === "execution.completed"),
        );
        expect(
          (
            await store.queryTurnResults("session", {
              newestFirst: true,
              limit: 1,
            })
          )[0]?.commitStatus,
        ).toBe("committed");
        const traces = await store.queryTraceEvents("session", {
          types: ["operation.failed"],
        });
        expect(
          traces.filter((event) => event.type === "operation.failed"),
        ).toHaveLength(1);
        expect(
          (await act()).filter((event) => event.type === "operation.failed"),
        ).toEqual([]);
      } finally {
        await closeTestApi(boot);
        await store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
