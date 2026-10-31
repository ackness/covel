import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { PluginServiceCallEvent } from "@covel/runtime";
import type { LLMAdapter, StorySegment } from "@covel/shared";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";
import { events } from "./__helpers/auto-advance.js";

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const excluded = [
  "narrator",
  "pregame",
  "world-init",
  "char-creator",
  "world-time",
  "memory",
  "history-compaction",
];
async function fixture(
  options: {
    role?: "host" | "spectator";
    missing?: boolean;
    failActor?: boolean;
    beforeActor?: () => Promise<void>;
  } = {},
) {
  const user = await mkdtemp(path.join(tmpdir(), "ensemble-user-"));
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", user);
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "ensemble-token");
  const store = createMemoryStore();
  const actorRequests: string[] = [],
    delegates: string[] = [];
  const llm: LLMAdapter = {
    generate: async (request) => {
      const text = JSON.stringify(request.messages);
      const reply = (value: unknown) => ({
        content: JSON.stringify(value),
        toolCalls: [],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      if (text.includes("Play only the character assigned")) {
        actorRequests.push(text);
        await options.beforeActor?.();
        request.signal?.throwIfAborted();
        const name = text.includes('\\"name\\":\\"Mara\\"') ? "Mara" : "Ivo";
        if (options.failActor && name === "Ivo")
          throw new Error("Actor unavailable");
        return reply({
          segments: [{ kind: "dialogue", text: `${name} replies.` }],
          intent: "PRIVATE-ACTOR-INTENT",
        });
      }
      const block = request.messages
        .map((message) =>
          typeof message.content === "string" ? message.content : "",
        )
        .join("\n")
        .match(/<runtime-inputs>\n([\s\S]*?)\n<\/runtime-inputs>/);
      const inputs = block?.[1]
        ? (JSON.parse(
            block[1]
              .replaceAll("&lt;", "<")
              .replaceAll("&gt;", ">")
              .replaceAll("&amp;", "&"),
          ) as {
            plan?: {
              value?: {
                actors: { character: string }[];
                cast: string[];
                yieldHint: string;
              };
            };
          })
        : undefined;
      const plan = inputs?.plan?.value;
      const delegateIds = new Set(
        request.messages
          .flatMap((message) => message.toolCalls ?? [])
          .filter((call) => call.name === "delegate")
          .map((call) => call.id),
      );
      const receipts = request.messages.filter(
        (message) =>
          message.role === "tool" &&
          message.toolCallId !== undefined &&
          delegateIds.has(message.toolCallId),
      );
      const next = plan?.actors[receipts.length];
      if (next) {
        delegates.push(next.character);
        return {
          content: null,
          toolCalls: [
            {
              id: `delegate-${receipts.length}`,
              name: "delegate",
              arguments: JSON.stringify({
                target: { contract: "character-actor@1" },
                character: next.character,
                brief: "The bell rings. Respond briefly.",
              }),
            },
          ],
          finishReason: "tool_calls",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      const segments: StorySegment[] = receipts.flatMap((message, index) => {
        const result = JSON.parse(String(message.content)) as {
          data?: { segments?: { kind: "dialogue" | "action"; text: string }[] };
        };
        return (result.data?.segments ?? []).map((segment) => ({
          ...segment,
          speaker: plan!.actors[index]!.character,
        }));
      });
      return reply({
        segments: [
          ...segments,
          { kind: "narration", text: "The bell grows quiet." },
        ],
        cues: { present: plan?.cast ?? [] },
        yield: segments.length ? (plan?.yieldHint ?? "user") : "user",
      });
    },
  };
  const root = path.resolve(import.meta.dirname, "../../../../plugins");
  const boot = await bootstrapApi({
    pluginsDir: root,
    pluginsDirs: [root, user],
    store,
    storeBackend: "memory",
    llmAdapter: llm,
    canRunRuntimeJobWithServerServices: () => true,
  });
  const headers = {
    "content-type": "application/json",
    Authorization: "Bearer ensemble-token",
  };
  const now = new Date().toISOString();
  const worldId = crypto.randomUUID();
  await store.createWorld({
    id: worldId,
    name: "Bell hall",
    description: "A hall for a short conversation.",
    locale: "en-US",
    metadata: {
      pluginSettings: {
        "turn-policy": { strategy: "list", actorOrder: "Mara\nIvo" },
        "chat-mode-narrator": { perspective: "dm" },
      },
    },
    createdAt: now,
  });
  const created = await boot.app.request("/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      worldId,
      locale: "en-US",
      seatRole: options.role ?? "host",
      autoAdvanceLimit: 2,
      plugins: [
        "chat-mode-narrator",
        ...(options.missing ? [] : ["character-agent", "turn-policy"]),
      ],
      excludedPlugins: excluded,
    }),
  });
  expect(created.status).toBe(201);
  const session = (await created.json()) as { id: string };
  for (const name of ["Mara", "Ivo"]) {
    const response = await boot.app.request(
      `/api/sessions/${session.id}/characters`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ id: `actor-${name}`, name, type: "npc" }),
      },
    );
    expect(response.status).toBeLessThan(300);
  }
  const post = (text = "Mara and Ivo, greet each other.") =>
    boot.app.request("/api/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        type: "submit_actions",
        sessionId: session.id,
        payload: { actions: [{ kind: "direct", seatId: "main", text }] },
      }),
    });
  return {
    boot,
    store,
    sessionId: session.id,
    post,
    headers,
    actorRequests,
    delegates,
    close: async () => {
      await closeTestApi(boot);
      await store.close();
      await rm(user, { recursive: true, force: true });
    },
  };
}

describe("bundled ensemble action flow", () => {
  it.each(["spectator", "invalid-fields"] as const)(
    "rejects a manual action before execution for %s",
    async (mode) => {
      const f = await fixture({
        role: mode === "spectator" ? "spectator" : "host",
      });
      try {
        const response = await f.boot.app.request("/api/actions", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            type: "submit_actions",
            sessionId: f.sessionId,
            payload: {
              actions: [
                {
                  kind: "turn-policy/choose-actors",
                  seatId: "main",
                  fields: {
                    actors: "Mara",
                    ...(mode === "invalid-fields" ? { unexpected: true } : {}),
                  },
                },
              ],
            },
          }),
        });
        expect(response.status).toBe(mode === "spectator" ? 409 : 400);
        if (mode === "spectator")
          expect(await response.json()).toMatchObject({
            code: "action_kind_not_allowed",
          });
        expect(f.delegates).toEqual([]);
        expect(f.actorRequests).toEqual([]);
        expect(await f.store.listMessages(f.sessionId)).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  it.each(["stop", "fresh-input"])(
    "interrupts a gated generated actor with %s while preserving the root story",
    async (mode) => {
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let calls = 0;
      const f = await fixture({
        beforeActor: async () => {
          if (calls++ === 2) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      try {
        const response = await f.post();
        const oldStream = response.text();
        await Promise.race([
          entered.promise,
          oldStream.then((wire) => {
            throw new Error(`The request ended before the actor gate: ${wire}`);
          }),
        ]);
        const prior = (await f.store.listMessages(f.sessionId)).filter(
          (message) => message.role === "assistant",
        );
        expect(prior).toHaveLength(1);
        let fresh: Promise<Response> | undefined;
        if (mode === "stop") {
          const stopped = await f.boot.app.request(
            `/api/sessions/${f.sessionId}/abort`,
            { method: "POST", headers: f.headers },
          );
          expect(stopped.ok).toBe(true);
        } else
          fresh = Promise.resolve(
            f.post("Mara and Ivo, start a new exchange."),
          );
        release.resolve();
        const stream = events(await oldStream);
        expect(
          stream.filter((event) => event.type === "execution.completed"),
        ).toHaveLength(1);
        expect(
          stream.filter((event) => event.type === "execution.advance").at(-1)
            ?.payload,
        ).toMatchObject({
          phase: "stopped",
          reason: mode === "stop" ? "player-stop" : "new-input",
        });
        if (fresh) {
          const next = events(await (await fresh).text());
          expect(
            next.filter((event) => event.type === "execution.round.completed"),
          ).toHaveLength(3);
        }
        const saved = (await f.store.listMessages(f.sessionId)).filter(
          (message) => message.role === "assistant",
        );
        expect(saved.some((message) => message.id === prior[0]!.id)).toBe(true);
        expect(saved).toHaveLength(mode === "stop" ? 1 : 4);
      } finally {
        release.resolve();
        await f.close();
      }
    },
  );
  it.each([false, true])(
    "commits a capped chain with isolated actor failure: %s",
    async (failActor) => {
      const f = await fixture({ failActor });
      try {
        const response = await f.post();
        expect(response.status, await response.clone().text()).toBe(200);
        const stream = events(await response.text());
        expect(
          stream.filter((event) => event.type === "execution.completed"),
        ).toHaveLength(1);
        expect(
          stream.filter((event) => event.type === "execution.round.completed"),
        ).toHaveLength(3);
        expect(
          stream.filter((event) => event.type === "execution.advance").at(-1)
            ?.payload,
        ).toMatchObject({ phase: "stopped", reason: "limit" });
        expect(f.delegates).toEqual([
          "Mara",
          "Ivo",
          "Mara",
          "Ivo",
          "Mara",
          "Ivo",
        ]);
        const stories = (await f.store.listMessages(f.sessionId)).filter(
          (message) => message.role === "assistant",
        );
        expect(stories).toHaveLength(3);
        expect(
          (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
        ).toBe(1);
        for (const story of stories) {
          expect(story.content).toContain("Mara replies.");
          if (failActor) expect(story.content).not.toContain("Ivo replies.");
          else
            expect(story.content.indexOf("Mara replies.")).toBeLessThan(
              story.content.indexOf("Ivo replies."),
            );
        }
        const traces = await f.store.queryTraceEvents(f.sessionId, {
          limit: 1000,
        });
        const serviceCalls = traces
          .filter((event) => event.type === "plugin.service.completed")
          .map((event) => ({
            ...event,
            payload: event.payload as PluginServiceCallEvent,
          }));
        const policyCalls = serviceCalls.filter(
          (event) => event.payload.contract === "turn-policy@1",
        );
        expect(policyCalls).toHaveLength(3);
        expect(JSON.stringify([stream, stories, traces])).not.toContain(
          "PRIVATE-ACTOR-INTENT",
        );
        const starts = traces.filter((event) => event.type === "turn.started");
        expect(new Set(starts.map((event) => event.turnId)).size).toBe(3);
        expect(
          serviceCalls.filter((event) => event.payload.extension === undefined),
        ).toEqual(policyCalls);
        for (const { turnId } of starts) {
          expect(
            policyCalls.filter((event) => event.turnId === turnId),
          ).toMatchObject([
            {
              payload: {
                runtimeId: "chat-mode-narrator/plan",
                providerPluginId: "turn-policy",
                outcome: "success",
              },
            },
          ]);
          expect(
            serviceCalls.filter(
              (event) =>
                event.turnId === turnId &&
                event.payload.extension !== undefined,
            ),
          ).toMatchObject([
            {
              payload: {
                contract: "prompt.segment@1",
                extension: {
                  point: "prompt.segment@1",
                  id: "character-sheets",
                },
                outcome: "success",
              },
            },
            {
              payload: {
                contract: "prompt.segment@1",
                extension: { point: "prompt.segment@1", id: "static-prompt" },
                outcome: "success",
              },
            },
          ]);
        }
      } finally {
        await f.close();
      }
    },
  );
  it("keeps a narrator-only session playable without companions", async () => {
    const f = await fixture({ missing: true });
    try {
      const response = await f.post();
      expect(response.status, await response.clone().text()).toBe(200);
      const stream = events(await response.text());
      expect(
        stream.filter((event) => event.type === "execution.round.completed"),
      ).toHaveLength(1);
      expect(f.actorRequests).toHaveLength(0);
      expect(
        (await f.store.listMessages(f.sessionId)).some((message) =>
          message.content.includes("The bell grows quiet."),
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
});
