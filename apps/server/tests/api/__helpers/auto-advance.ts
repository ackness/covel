import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import type { HookPipeline } from "@covel/runtime";
import type { LLMAdapter, SseEnvelope } from "@covel/shared";
import { bootstrapApi } from "../../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../../helpers/close-api.js";

export const gate = () => Promise.withResolvers<void>();
export function events(text: string): SseEnvelope[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as SseEnvelope);
}
export async function advanceFixture(
  options: {
    limit?: number;
    yields?: readonly ("continue" | "user" | undefined)[];
    onGenerate?: (
      index: number,
      request: Parameters<LLMAdapter["generate"]>[0],
    ) => Promise<void>;
    hooks?: HookPipeline;
    store?: DataStore;
    databaseUrl?: string;
    sessionLock?: import("../../../src/lib/session-lock.js").SessionLock;
    noProvider?: boolean;
    emptyOutput?: boolean;
    prepare?: (
      builtin: string,
      store: DataStore,
      sessionId: string,
    ) => Promise<void>;
    ambiguous?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "advance-"));
  const builtin = join(dir, "builtin");
  const user = join(dir, "user");
  await mkdir(user);
  await mkdir(builtin);
  for (const id of options.noProvider
    ? []
    : options.ambiguous
      ? ["story", "other-story"]
      : ["story"]) {
    await mkdir(join(builtin, id));
    await writeFile(
      join(builtin, id, "PLUGIN.md"),
      `---
id: ${id}
description: A scripted story provider
runtime:
  schedule: { stage: narrative }
  io:
    visibility: story
    output: { contract: narrative-engine@2 }
---
Tell a short story.
`,
    );
  }
  await mkdir(join(builtin, "observer"));
  await writeFile(
    join(builtin, "observer", "PLUGIN.md"),
    `---
id: observer
description: Record each execution's inputs
runtime:
  schedule: { stage: post-turn }
  function: { handler: ./handler.mjs }
---
`,
  );
  await writeFile(
    join(builtin, "observer", "handler.mjs"),
    `export default async function(ctx) {
    return { outcome: "success", value: {}, effects: { pluginData: [{ namespace: "rounds", key: ctx.turnId,
      value: { logicalTurn: ctx.logicalTurn, actions: ctx.playerActions } }] } };
  }`,
  );
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", user);
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "advance-test-token");
  vi.stubEnv("NODE_ENV", "production");
  if (options.databaseUrl) vi.stubEnv("DATABASE_URL", options.databaseUrl);
  const store = options.store ?? createMemoryStore();
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  await store.createSession({
    id: sessionId,
    status: "active",
    phase: "playing",
    locale: "en-US",
    completedPlayerTurns: 4,
    setupRuntimes: {},
    seats: [
      { id: "human", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [
      ...(options.noProvider
        ? []
        : options.ambiguous
          ? ["story", "other-story"]
          : ["story"]),
      "observer",
    ],
    metadata: {
      sessionIncarnationNonce: crypto.randomUUID(),
      approvalScopeNonce: crypto.randomUUID(),
      ...(options.limit !== undefined
        ? { autoAdvanceLimit: options.limit }
        : {}),
    },
    createdAt: now,
    updatedAt: now,
  });
  await options.prepare?.(builtin, store, sessionId);
  let calls = 0;
  const boot = await bootstrapApi({
    pluginsDir: builtin,
    pluginsDirs: [builtin, user],
    store,
    storeBackend: options.databaseUrl ? "pg" : "memory",
    sessionLock: options.sessionLock,
    canRunRuntimeJobWithServerServices: () => true,
    llmAdapter: {
      generate: async (request) => {
        const index = calls++;
        await options.onGenerate?.(index, request);
        const yieldValue = options.yields ? options.yields[index] : "continue";
        return {
          content: options.emptyOutput
            ? ""
            : JSON.stringify({
                segments: [{ kind: "narration", text: `Story ${index + 1}.` }],
                ...(yieldValue ? { yield: yieldValue } : {}),
              }),
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
    perRequestMiddleware: options.hooks
      ? [
          async (c, next) => {
            c.set("hookPipeline", options.hooks!);
            await next();
          },
        ]
      : [],
  });
  const headers = {
    Authorization: "Bearer advance-test-token",
    "Content-Type": "application/json",
  };
  const post = async (
    payload: Record<string, unknown> = {
      actions: [{ kind: "say", text: "Begin" }],
    },
    type = "submit_actions",
  ) =>
    boot.app.request("/api/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        type,
        sessionId,
        payload,
      }),
    });
  const status = async () =>
    (
      await boot.app.request(`/api/sessions/${sessionId}/execution`, {
        headers,
      })
    ).json();
  const stop = () =>
    boot.app.request(`/api/sessions/${sessionId}/abort`, {
      method: "POST",
      headers,
    });
  return {
    boot,
    store,
    sessionId,
    headers,
    post,
    status,
    stop,
    calls: () => calls,
    async close() {
      await closeTestApi(boot);
      if (!options.store) await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
