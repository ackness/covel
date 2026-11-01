import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import type { DataStore } from "@covel/store";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import {
  commitExecution,
  createHookPipeline,
  executeTurn,
} from "@covel/runtime";
import { committedAdvanceDecision } from "../../src/routes/api/actions/auto-advance.js";

const stores: DataStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});
describe.each([
  ["memory", createMemoryStore],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const)("submitted advancement on %s", (_name, create) => {
  it.each([
    "committed",
    "invalid",
    "review",
    "PostRuntime",
    "rollback",
    "cancelled",
    "child",
  ] as const)("reads only committed top-level yield (%s)", async (mode) => {
    const store = create();
    stores.push(store);
    const now = "2026-11-01T00:00:00.000Z";
    await store.createSession({
      id: "session",
      status: "active",
      phase: "playing",
      locale: "en-US",
      activePlugins: ["probe"],
      seats: [],
      setupRuntimes: {},
      completedPlayerTurns: 0,
      createdAt: now,
      updatedAt: now,
    });
    const controller = new AbortController();
    const hooks = createHookPipeline();
    if (mode === "review" || mode === "cancelled")
      hooks.register({
        id: "review",
        event: "ReviewAgentOutput",
        handler: async () => {
          if (mode === "cancelled") controller.abort();
          return {
            action: "continue",
            ...(mode === "review"
              ? { replace: { correction: "Refused." } }
              : {}),
          };
        },
      });
    if (mode === "PostRuntime")
      hooks.register({
        id: "erase",
        event: "PostRuntime",
        handler: async (_ctx, payload) => ({
          action: "continue",
          replace: {
            result: {
              ...(payload as { result: RuntimeResult }).result,
              output: { narrativeOutput: " " },
            },
          },
        }),
      });
    const child: RuntimeManifest = {
      name: "probe/child",
      pluginId: "probe",
      description: "Child",
      runtimeType: "agent",
      outputKind: "system",
      subagentOnly: true,
      trigger: { type: "manual" },
    };
    const main: RuntimeManifest = {
      name: "probe/main",
      pluginId: "probe",
      description: "Story",
      runtimeType: mode === "child" ? "function" : "agent",
      stage: "narrative",
      outputKind: mode === "child" ? "system" : "story",
      ...(mode === "child" ? {} : { outputContract: "narrative-engine@2" }),
      trigger: { type: "auto" },
      maxRetries: 0,
    };
    const execution = await executeTurn(
      {
        sessionId: "session",
        turnId: "turn",
        origin: "player",
        logicalTurnId: "logical",
        playerMessage: "Go",
      },
      mode === "child" ? [main, child] : [main],
      {
        store,
        hookPipeline: hooks,
        turnControl: { signal: controller.signal },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "Submit the story.",
          ...(manifest.runtimeType === "function"
            ? {
                handler: async (ctx) => {
                  const result = await ctx.agents!.run({
                    target: { runtimeId: child.name },
                    brief: "Continue",
                  });
                  expect(result.ok).toBe(true);
                  return { outcome: "success" as const, value: {} };
                },
              }
            : {}),
        }),
        llm: {
          generate: async () => ({
            content: null,
            toolCalls: [
              {
                id: "submission",
                name: "submit-output",
                arguments: JSON.stringify({
                  narrativeOutput: mode === "invalid" ? " " : "The gate opens.",
                  yield: "continue",
                }),
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        },
      },
    );
    const outcome = await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: "turn", durationMs: 0 },
      ...(mode === "rollback"
        ? {
            extraInTx: async () => {
              throw new Error("rollback");
            },
          }
        : {}),
    });
    expect(await committedAdvanceDecision(store, "session", outcome)).toBe(
      mode === "committed"
        ? undefined
        : mode === "child"
          ? "no-eligible-story"
          : "execution-failed",
    );
    expect(
      (await store.listMessages("session")).filter(
        (row) => row.role === "assistant",
      ),
    ).toHaveLength(mode === "committed" ? 1 : 0);
  });
});
