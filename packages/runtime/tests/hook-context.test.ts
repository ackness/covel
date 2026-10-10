import { expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { HOOK_EVENTS, type RuntimeManifest } from "@covel/shared";
import {
  commitExecution,
  createHookPipeline,
  executeTurn,
} from "../src/index.js";

/** Events that concern one runtime, and so carry its identity in the context. */
const RUNTIME_EVENTS = [
  "PreRuntime",
  "PostContextAssembly",
  "PreLLMCall",
  "PostLLMResponse",
  "PreToolUse",
  "PostToolUse",
  "PostRuntime",
  "PreStateCommit",
  "PostStateCommit",
];

it("gives every hook the session locale, and the runtime identity in the context only", async () => {
  const store = createMemoryStore();
  const timestamp = "2026-10-10T00:00:00.000Z";
  await store.createSession({
    id: "session",
    locale: "ja",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: ["teller", "ledger"],
    completedPlayerTurns: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const teller: RuntimeManifest = {
    name: "teller/story",
    pluginId: "teller",
    runtimeType: "agent",
    stage: "narrative",
    outputKind: "story",
    trigger: { type: "auto" },
    tools: { builtin: [], plugin: [] },
  };
  const ledger: RuntimeManifest = {
    name: "ledger/write",
    pluginId: "ledger",
    runtimeType: "function",
    stage: "post-turn",
    outputKind: "plugin",
    trigger: { type: "auto" },
  };
  const hookPipeline = createHookPipeline();
  const seen: Array<{
    event: string;
    locale?: string;
    pluginId?: string;
    runtimeId?: string;
    payloadKeys: string[];
  }> = [];
  for (const event of HOOK_EVENTS)
    hookPipeline.register({
      id: `watcher:${event}`,
      pluginId: "watcher",
      event,
      handler: async (context, payload) => {
        seen.push({
          event,
          locale: context.locale,
          pluginId: context.pluginId,
          runtimeId: context.runtimeId,
          payloadKeys: Object.keys(payload as object),
        });
        return { action: "continue" };
      },
    });
  const replies = [
    {
      content: null,
      toolCalls: [{ id: "call", name: "look", arguments: "{}" }],
      finishReason: "tool_calls" as const,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      content: "The door opens.",
      toolCalls: [],
      finishReason: "stop" as const,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];
  const execution = await executeTurn(
    {
      sessionId: "session",
      turnId: "turn",
      playerMessage: "Open the door",
      locale: "ja",
    },
    [teller, ledger],
    {
      store,
      hookPipeline,
      hookScope: { activePluginIds: new Set(["teller", "ledger", "watcher"]) },
      llm: { generate: vi.fn(async () => replies.shift()!) },
      toolExecutor: {
        execute: vi.fn(async () => ({
          result: '{"ok":true}',
          parsedResult: { ok: true },
          success: true,
        })),
        getToolInfo: vi.fn(() => ({
          name: "look",
          description: "Look",
          jsonSchema: { type: "object" },
        })),
      },
      loadRuntime: async (name) =>
        name === teller.name
          ? { manifest: teller, promptTemplate: "Tell the story." }
          : {
              manifest: ledger,
              promptTemplate: "",
              handler: async () => ({
                outcome: "success",
                value: {},
                effects: {
                  pluginData: [{ namespace: "log", key: "last", value: 1 }],
                },
              }),
            },
    },
  );
  const outcome = await commitExecution({
    store,
    execution,
    hookPipeline,
    completion: { kind: "turn", turnId: "turn", durationMs: 0 },
  });
  expect(outcome.status).toBe("committed");

  const fired = new Set(seen.map((entry) => entry.event));
  for (const event of [...RUNTIME_EVENTS, "TurnStart", "TurnStop"])
    expect(fired, event).toContain(event);
  for (const entry of seen) {
    expect(entry.locale, entry.event).toBe("ja");
    // One place for the identity: no payload repeats it.
    expect(entry.payloadKeys, entry.event).not.toContain("pluginId");
    expect(entry.payloadKeys, entry.event).not.toContain("runtimeId");
    if (!RUNTIME_EVENTS.includes(entry.event)) {
      expect(entry.runtimeId, entry.event).toBeUndefined();
      continue;
    }
    expect(
      [
        ["teller", "teller/story"],
        ["ledger", "ledger/write"],
      ],
      entry.event,
    ).toContainEqual([entry.pluginId, entry.runtimeId]);
  }
  const identities = (event: string) =>
    seen.filter((entry) => entry.event === event).map((e) => e.runtimeId);
  expect(identities("PreLLMCall")).toEqual(["teller/story", "teller/story"]);
  expect(identities("PreToolUse")).toEqual(["teller/story"]);
  expect(identities("PreStateCommit")).toContain("ledger/write");
});
