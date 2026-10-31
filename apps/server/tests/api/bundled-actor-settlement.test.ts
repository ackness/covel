import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type {
  LLMAdapter,
  LLMResponse,
  Proposal,
  RuntimeResult,
  StorySegment,
  SseEnvelope,
} from "@covel/shared";
import { createHookPipeline } from "@covel/runtime";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
afterEach(() => vi.unstubAllEnvs());

const usage = { inputTokens: 1, outputTokens: 1 };
const prose = (content: string): LLMResponse => ({
  content,
  toolCalls: [],
  finishReason: "stop",
  usage,
});
const toolCall = (
  name: string,
  args: Record<string, unknown>,
  id: string,
): LLMResponse => ({
  content: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  finishReason: "tool_calls",
  usage,
});

describe("bundled dialogue actor write settlement", () => {
  it.each(["actor-failure", "commit-rejection"] as const)(
    "preserves independent writes and the story through %s and emits the settled action stream",
    async (mode) => {
      const directory = await mkdtemp(path.join(tmpdir(), "actor-settlement-"));
      const builtin = path.join(directory, "builtin");
      const user = path.join(directory, "user");
      const store = createMemoryStore();
      let boot: ApiBootstrapResult | undefined;
      const staged: string[] = [];
      const actorReplies: string[] = [];
      try {
        await mkdir(user);
        await mkdir(builtin);
        const plugins = path.resolve(
          import.meta.dirname,
          "../../../../plugins",
        );
        for (const id of ["chat-mode-narrator", "turn-policy"])
          await cp(path.join(plugins, id), path.join(builtin, id), {
            recursive: true,
          });
        const replacement = path.join(builtin, "replacement-actor");
        await mkdir(replacement);
        await writeFile(
          path.join(replacement, "PLUGIN.md"),
          `---
description: A character actor that stages optional changes
runtime:
  schedule: { subagentOnly: true }
  io:
    output: { contract: character-actor@1 }
  agent:
    tools:
      services: [{ contract: actor-change@1, as: change }]
---
Play the assigned replacement character. Stage one change, then answer.
`,
        );
        const ledger = path.join(builtin, "actor-ledger");
        await mkdir(ledger);
        await writeFile(
          path.join(ledger, "PLUGIN.md"),
          `---
description: Optional actor changes
entry: ./entry.mjs
contributes:
  services: [{ contract: actor-change@1, access: write, modelFacing: true }]
---
`,
        );
        await writeFile(
          path.join(ledger, "entry.mjs"),
          `export default function(api) {
  const z = api.toolkit.z;
  api.registerService({ name: "change", contract: "actor-change@1", access: "write", modelFacing: true,
    description: "Record an optional character action", input: z.object({ name: z.string() }), output: z.unknown(),
    handler: async ({ name }, ctx) => {
      await ctx.pluginData.set("items", name, { owned: true });
      await ctx.pluginData.set("receipts", name, { accepted: true });
      return { name };
    }
  });
}
`,
        );
        vi.stubEnv("COVEL_USER_PLUGINS_DIR", user);
        vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "actor-settlement-token");
        vi.stubEnv("NODE_ENV", "production");
        const now = new Date().toISOString();
        await store.createWorld({
          id: "hall",
          name: "Bell hall",
          description: "A short exchange.",
          locale: "en-US",
          createdAt: now,
          metadata: {
            pluginSettings: {
              "turn-policy": { strategy: "list", actorOrder: "Mara\nIvo" },
              "chat-mode-narrator": { perspective: "dm" },
            },
          },
        });
        await store.createSession({
          id: "scene",
          worldId: "hall",
          locale: "en-US",
          status: "active",
          phase: "playing",
          setupRuntimes: {},
          completedPlayerTurns: 0,
          seats: [
            { id: "main", controller: "human", role: "host", characters: [] },
          ],
          activePlugins: [
            "chat-mode-narrator",
            "turn-policy",
            "replacement-actor",
            "actor-ledger",
          ],
          metadata: {
            approvalScopeNonce: crypto.randomUUID(),
            sessionIncarnationNonce: crypto.randomUUID(),
          },
          createdAt: now,
          updatedAt: now,
        });
        for (const name of ["Mara", "Ivo"])
          await store.upsertCharacter({
            id: `character-${name}`,
            name,
            sessionId: "scene",
            type: "npc",
            version: 1,
            createdAt: now,
            updatedAt: now,
          });
        const hooks = createHookPipeline();
        hooks.register<{ proposal: Proposal }>({
          id: "reject-actor-receipt",
          pluginId: "actor-ledger",
          event: "PreStateCommit",
          handler: async (_ctx, { proposal }) =>
            mode === "commit-rejection" &&
            proposal.type === "plugin.data" &&
            proposal.payload.namespace === "receipts" &&
            proposal.payload.key === "Ivo"
              ? { action: "abort", reason: "PRIVATE-REJECTION-DETAIL" }
              : { action: "continue" },
        });
        const llm: LLMAdapter = {
          generate: async (request) => {
            const text = JSON.stringify(request.messages);
            if (text.includes("Play the assigned replacement character")) {
              const name = text.includes('\\"name\\":\\"Mara\\"')
                ? "Mara"
                : "Ivo";
              const receipt = request.messages.find(
                (message) => message.role === "tool",
              );
              if (!receipt)
                return toolCall("change", { name }, `change-${name}`);
              expect(JSON.parse(String(receipt.content))).toMatchObject({
                staged: { count: 1 },
              });
              staged.push(name);
              if (mode === "actor-failure" && name === "Ivo")
                throw new Error("Actor failed after staging");
              actorReplies.push(name);
              return prose(
                JSON.stringify({
                  segments: [{ kind: "dialogue", text: `${name} answers.` }],
                }),
              );
            }
            const block = request.messages
              .map((message) =>
                typeof message.content === "string" ? message.content : "",
              )
              .join("\n")
              .match(/<runtime-inputs>\n([\s\S]*?)\n<\/runtime-inputs>/)?.[1];
            expect(block).toBeDefined();
            const {
              plan: { value: plan },
            } = JSON.parse(
              block!
                .replaceAll("&lt;", "<")
                .replaceAll("&gt;", ">")
                .replaceAll("&amp;", "&"),
            ) as {
              plan: {
                value: {
                  actors: { character: string }[];
                  brief: string;
                  cast: string[];
                };
              };
            };
            const receipts = request.messages.filter(
              (message) => message.role === "tool",
            );
            const next = plan.actors[receipts.length];
            if (next)
              return toolCall(
                "delegate",
                {
                  target: { contract: "character-actor@1" },
                  character: next.character,
                  brief: plan.brief,
                },
                `delegate-${next.character}`,
              );
            const segments: StorySegment[] = receipts.flatMap(
              (message, index) => {
                const result = JSON.parse(String(message.content)) as {
                  data?: {
                    segments?: { kind: "dialogue" | "action"; text: string }[];
                  };
                };
                return (result.data?.segments ?? []).map((segment) => ({
                  ...segment,
                  speaker: plan.actors[index]!.character,
                }));
              },
            );
            return prose(
              JSON.stringify({
                segments: [
                  ...segments,
                  { kind: "narration", text: "The bell grows quiet." },
                ],
                cues: { present: plan.cast },
                yield: "user",
              }),
            );
          },
        };
        boot = await bootstrapApi({
          pluginsDir: builtin,
          pluginsDirs: [builtin, user],
          store,
          storeBackend: "memory",
          llmAdapter: llm,
          perRequestMiddleware: [
            async (ctx, next) => {
              ctx.set("hookPipeline", hooks);
              await next();
            },
          ],
        });
        const response = await boot.app.request("/api/actions", {
          method: "POST",
          headers: {
            Authorization: "Bearer actor-settlement-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            sessionId: "scene",
            type: "submit_actions",
            payload: {
              actions: [
                {
                  kind: "narrate",
                  seatId: "main",
                  text: "Mara and Ivo arrive as the bell rings.",
                },
              ],
            },
          }),
        });
        const wire = await response.text();
        expect(response.status, wire).toBe(200);
        const events = wire
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as SseEnvelope);
        expect(staged).toEqual(["Mara", "Ivo"]);
        expect(actorReplies).toEqual(
          mode === "actor-failure" ? ["Mara"] : ["Mara", "Ivo"],
        );
        for (const namespace of ["items", "receipts"]) {
          expect(
            (
              await store.listPluginData("scene", "actor-ledger", namespace)
            ).map((row) => row.key),
          ).toEqual(["Mara"]);
        }
        const stories = (await store.listMessages("scene")).filter(
          (message) => message.role === "assistant",
        );
        expect(stories).toHaveLength(1);
        expect(stories[0]!.content).toContain("Mara answers.");
        expect(stories[0]!.content).toContain("The bell grows quiet.");
        if (mode === "commit-rejection")
          expect(stories[0]!.content).toContain("Ivo answers.");
        else expect(stories[0]!.content).not.toContain("Ivo answers.");
        const results = await store.listTurnResults("scene");
        expect(results).toHaveLength(1);
        expect(results[0]!.commitStatus).toBe("committed");
        const operations = (
          results[0]!.runtimeResults as RuntimeResult[]
        ).flatMap((result) => result.operations ?? []);
        expect(operations.map(({ status }) => status)).toEqual([
          "committed",
          mode === "actor-failure" ? "discarded" : "failed",
        ]);
        const traces = await store.queryTraceEvents("scene", { limit: 1000 });
        expect(
          traces.filter((event) => event.type === "subagent.started"),
        ).toHaveLength(2);
        expect(
          traces.filter((event) => event.type === "subagent.failed"),
        ).toHaveLength(mode === "actor-failure" ? 1 : 0);
        expect(
          events.filter((event) =>
            ["proposal.failed", "error.occurred"].includes(event.type),
          ),
        ).toEqual([]);
        expect(
          events.filter((event) => event.type === "operation.failed"),
        ).toHaveLength(mode === "commit-rejection" ? 1 : 0);
        expect(events.at(-1)).toMatchObject({
          type: "execution.completed",
          payload: { committed: true },
        });
        const turnId = events.at(-1)!.turnId;
        // The web settlement test replays these events with fixed correlation
        // IDs. Keep their order and player-visible payloads in agreement.
        const settlementTypes = new Set([
          "execution.started",
          "runtime.started",
          "runtime.completed",
          "tool.completed",
          "tool.failed",
          "plugin-data.changed",
          "narrative.completed",
          "operation.failed",
          "ui.slot.cleared",
          "execution.round.completed",
          "execution.advance",
          "execution.completed",
        ]);
        const planner = {
          pluginId: "chat-mode-narrator",
          runtimeId: "chat-mode-narrator/plan",
        };
        const narrator = {
          pluginId: "chat-mode-narrator",
          runtimeId: "chat-mode-narrator/narrate",
        };
        const actor = {
          pluginId: "replacement-actor",
          runtimeId: "replacement-actor",
        };
        const completed = {
          runtimeCount: 3,
          resultCount: 2,
          durationMs: expect.any(Number),
          committed: true,
        };
        expect(
          events.filter(({ type }) => settlementTypes.has(type)),
        ).toMatchObject([
          {
            type: "execution.started",
            payload: { status: "executing", runtimeCount: 3 },
          },
          {
            type: "runtime.started",
            payload: { ...planner, stage: "pre-turn", kind: "system" },
          },
          {
            type: "runtime.completed",
            payload: { ...planner, status: "success" },
          },
          {
            type: "runtime.started",
            payload: { ...narrator, stage: "narrative", kind: "story" },
          },
          {
            type: "tool.completed",
            payload: {
              ...actor,
              toolName: "change",
              toolCallId: "change-Mara",
              success: true,
            },
          },
          {
            type: "tool.completed",
            payload: {
              ...narrator,
              toolName: "delegate",
              toolCallId: "delegate-Mara",
              success: true,
            },
          },
          {
            type: "tool.completed",
            payload: {
              ...actor,
              toolName: "change",
              toolCallId: "change-Ivo",
              success: true,
            },
          },
          {
            type: mode === "actor-failure" ? "tool.failed" : "tool.completed",
            payload: {
              ...narrator,
              toolName: "delegate",
              toolCallId: "delegate-Ivo",
              success: mode !== "actor-failure",
            },
          },
          {
            type: "runtime.completed",
            payload: { ...narrator, status: "success" },
          },
          {
            type: "plugin-data.changed",
            payload: {
              pluginId: "actor-ledger",
              changes: [
                {
                  namespace: "items",
                  key: "Mara",
                  value: { owned: true },
                  operation: "set",
                },
              ],
            },
          },
          {
            type: "plugin-data.changed",
            payload: {
              pluginId: "actor-ledger",
              changes: [
                {
                  namespace: "receipts",
                  key: "Mara",
                  value: { accepted: true },
                  operation: "set",
                },
              ],
            },
          },
          {
            type: "narrative.completed",
            payload: {
              ...narrator,
              kind: "story",
              content:
                mode === "commit-rejection"
                  ? "Mara answers.\n\nIvo answers.\n\nThe bell grows quiet."
                  : "Mara answers.\n\nThe bell grows quiet.",
            },
          },
          ...(mode === "commit-rejection"
            ? [
                {
                  type: "operation.failed",
                  payload: { sessionId: "scene", turnId, count: 1 },
                },
              ]
            : []),
          { type: "ui.slot.cleared", payload: { turnId } },
          {
            type: "execution.round.completed",
            payload: {
              ...completed,
              requestId: expect.any(String),
              rootId: expect.any(String),
              turnId,
              round: 0,
              limit: 3,
            },
          },
          {
            type: "execution.advance",
            payload: {
              phase: "stopped",
              reason: "yielded-to-player",
              round: 0,
              limit: 3,
            },
          },
          { type: "execution.completed", payload: completed },
        ]);
      } finally {
        await closeTestApi(boot);
        await store.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
