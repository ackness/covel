import { submittedOutput } from "../helpers/output-submission.js";
import { createPresentationBrowserFixture } from "../helpers/presentation-browser.js";
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
          if (index >= 2)
            return submittedOutput({
              narrativeOutput: "The story continues.",
              segments: [{ kind: "narration", text: "The story continues." }],
              yield: advance && index === 2 ? "continue" : "user",
            });
          return {
            content: null,
            toolCalls: [
              {
                id: `call-${index}`,
                name: "change",
                arguments: JSON.stringify({
                  key: index === 0 ? "kept" : "rejected",
                }),
              },
            ],
            finishReason: "tool_calls",
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
        const saved = await store.listMessages("session");
        const stories = saved.filter(
          (message) =>
            (message.metadata as { kind?: string })?.kind === "story",
        );
        const marked = stories.filter(
          (message) =>
            (message.metadata as { operationFailures?: unknown })
              .operationFailures,
        );
        expect(marked).toHaveLength(1);
        expect(marked[0]?.metadata).toMatchObject({
          turnId: failed[0]?.turnId,
          operationFailures: { count: 1 },
        });
        expect(failed[0]?.payload.messages).toEqual([
          { messageId: marked[0]!.id, count: 1 },
        ]);
        expect(stories).toHaveLength(advance ? 2 : 1);
        expect(
          events.findIndex((event) => event.type === "narrative.completed"),
        ).toBeLessThan(
          events.findIndex((event) => event.type === "operation.failed"),
        );
        for (const suffix of ["messages", "messages/page", "view"]) {
          const response = await boot!.app.request(
            `/api/sessions/session/${suffix}`,
            { headers: { Authorization: "Bearer synthetic-operation-token" } },
          );
          expect(response.status).toBe(200);
          const body = (await response.json()) as {
            items?: { id: string; operationFailures?: unknown }[];
            messages?: { id: string; operationFailures?: unknown }[];
          };
          expect(
            (body.items ?? body.messages)?.find(
              (message) => message.id === marked[0]!.id,
            )?.operationFailures,
          ).toEqual({ count: 1 });
        }
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
        for (const [id, role, kind, operationFailures] of [
          ["invalid-count", "assistant", "story", { count: 0 }],
          [
            "secret-count",
            "assistant",
            "story",
            { count: 1, summary: "PRIVATE-MARKER" },
          ],
          ["wrong-role", "user", "story", { count: 1 }],
          ["wrong-kind", "assistant", "system", { count: 1 }],
        ] as const) {
          await store.addMessage({
            id,
            sessionId: "session",
            role,
            content: "Synthetic content",
            metadata: { kind, operationFailures, request: "PRIVATE-REQUEST" },
            createdAt: new Date().toISOString(),
          });
        }
        for (const suffix of ["messages", "messages/page", "view"]) {
          const response = await boot!.app.request(
            `/api/sessions/session/${suffix}`,
            { headers: { Authorization: "Bearer synthetic-operation-token" } },
          );
          const body = (await response.json()) as {
            items?: { id: string; operationFailures?: unknown }[];
            messages?: { id: string; operationFailures?: unknown }[];
          };
          const messages = body.items ?? body.messages ?? [];
          for (const id of [
            "invalid-count",
            "secret-count",
            "wrong-role",
            "wrong-kind",
          ])
            expect(
              messages.find((message) => message.id === id)?.operationFailures,
            ).toBeUndefined();
          expect(JSON.stringify(messages)).not.toContain("PRIVATE-MARKER");
          expect(JSON.stringify(messages)).not.toContain("PRIVATE-REQUEST");
        }
        const synced = await boot!.app.request(
          "/api/sessions/session/messages/sync",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer synthetic-operation-token",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messages: [
                {
                  id: "forged",
                  role: "assistant",
                  kind: "story",
                  content: "Client text",
                  operationFailures: { count: 99 },
                  metadata: { kind: "story", operationFailures: { count: 99 } },
                },
              ],
            }),
          },
        );
        expect(synced.status).toBe(200);
        expect(
          (await store.getMessage("session", "forged"))?.metadata,
        ).not.toHaveProperty("operationFailures");
      } finally {
        await closeTestApi(boot);
        await store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

it("commits the browser fixture's refused purchase with a saved story notice without sockets", async () => {
  const fixture = await createPresentationBrowserFixture("updated", {
    failOperation: true,
  });
  try {
    const response = await fixture.app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId: fixture.sessionId,
        type: "submit_actions",
        payload: { actions: [{ kind: "say", text: "Buy a book" }] },
      }),
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"operation.failed"');
    expect(
      (await fixture.store.listMessages(fixture.sessionId)).filter(
        (row) =>
          (row.metadata as { operationFailures?: unknown })?.operationFailures,
      ),
    ).toHaveLength(1);
    expect(
      await fixture.store.listPluginData(
        fixture.sessionId,
        "purchase-probe",
        "purchases",
      ),
    ).toEqual([]);
    expect(fixture.calls()).toBe(1);
  } finally {
    fixture.release();
    await fixture.close();
  }
});
