import assert from "node:assert/strict";
import { isJsonValue } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import {
  createCharacterTools,
  worldDimensionGetTool,
  worldDimensionListTool,
  runtimeDoneTool,
} from "@covel/tools";
import {
  executeTurn,
  commitExecution,
  createToolExecutor,
} from "../../src/index.js";
import { loadRuntimeBundle } from "../../../test-runtime/src/runtime-loading.js";
import { DIMENSION_DATA_NAMESPACE } from "@covel/plugin-handlers-utils/dimensions";
import type {
  LLMAdapter,
  LLMAdapterMessage,
  TurnExecutorDeps,
} from "../../src/index.js";

const now = "2026-01-01T00:00:00Z";
const segment = {
  kind: "dialogue",
  speaker: "Mira",
  text: "“Thank you. I’m glad you’re free after school.”",
};

export async function runAttributionTurn(
  pluginsDir: string,
  story: Record<string, unknown> = { segments: [segment] },
  locale = "en-US",
  providerName = "narrator",
  retryWorldIR = false,
) {
  assert.ok(isJsonValue(story));
  const store = createMemoryStore();
  const sessionId = "attribution-synthetic";
  const providerPackage =
    providerName === "chat-mode-narrator" ? providerName : "narrator";
  const pluginIds = ["world-ir", "char-creator", "world-init", providerPackage];
  const providerId =
    providerName === "synthetic-story" ? "external-author" : providerPackage;
  await store.createSession({
    id: sessionId,
    locale,
    status: "active",
    phase: "playing",
    metadata: { _dimensionProviderPluginId: "world-init" },
    completedPlayerTurns: 1,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [...pluginIds, providerId],
    createdAt: now,
    updatedAt: now,
  });
  for (const [id, name, type] of [
    ["char-player", locale === "zh-CN" ? "阿历克斯" : "Alex", "player"],
    ["char-mira", locale === "zh-CN" ? "米拉" : "Mira", "npc"],
    ["char-lin", locale === "zh-CN" ? "林" : "Lin", "npc"],
  ]) {
    await store.upsertCharacter({
      id: id!,
      sessionId,
      name: name!,
      type: type!,
      aliases:
        id === "char-mira"
          ? [locale === "zh-CN" ? "守书人" : "the Keeper"]
          : [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  await store.setPluginData({
    sessionId,
    pluginId: "world-init",
    id: "dimension-row",
    createdAt: now,
    namespace: DIMENSION_DATA_NAMESPACE,
    key: "observations",
    value: {
      definition: {
        name: "Observations",
        schema: { type: "array", items: { type: "string" } },
        initialValue: [],
        updateRule: "Record explicitly completed actions with their actors.",
      },
      value: [],
      version: 1,
    },
    updatedAt: now,
  });
  const bundle = await loadRuntimeBundle({
    pluginsDir,
    pluginId: "world-ir",
    runtimeId: "world-ir",
    locale,
    withPlugins: pluginIds.slice(1),
    store,
  });
  const storyRuntime = bundle.manifests.find(
    (manifest) =>
      manifest.pluginId === providerPackage && manifest.outputKind === "story",
  )!.name;
  const selected = new Set([
    storyRuntime,
    "world-ir",
    "char-creator/character-tracker",
    "world-init/dimension-tracker",
    "world-init/edit-dimensions",
  ]);
  const manifests = bundle.manifests
    .filter((m) => selected.has(m.name))
    .map((m) =>
      m.name === storyRuntime
        ? {
            ...m,
            name: providerName,
            pluginId: providerId,
            runtimeType: "function" as const,
            handler: "./synthetic.js",
          }
        : m,
    );
  const calls: { tool: string; messages: readonly LLMAdapterMessage[] }[] = [];
  let failWorldIR = retryWorldIR;
  const llm: LLMAdapter = {
    async generate(p) {
      const tool = [
        "submit-world-facts",
        "sync-characters",
        "update-dimensions",
      ].find((n) => p.tools?.some((t) => t.name === n));
      assert.ok(tool, "only synthetic writer calls are allowed");
      calls.push({ tool, messages: p.messages });
      if (tool === "submit-world-facts" && failWorldIR) {
        failWorldIR = false;
        throw new Error("Synthetic non-retryable extraction failure");
      }
      const args =
        tool === "submit-world-facts"
          ? {
              schemaVersion: 1,
              summary: "Synthetic transport check.",
              entities: [],
              relations: [],
              events: [],
              statements: [],
            }
          : tool === "sync-characters"
            ? { creates: [], updates: [] }
            : { updates: [] };
      return {
        content: null,
        toolCalls: [
          {
            id: `call-${calls.length}`,
            name: tool,
            arguments: JSON.stringify(args),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const builtin = new Map(
    [
      ...createCharacterTools(store),
      worldDimensionGetTool,
      worldDimensionListTool,
      runtimeDoneTool,
    ].map((t) => [t.name, t]),
  );
  const executor = createToolExecutor({
    store,
    findTool: (name, context) =>
      builtin.get(name) ??
      bundle.entryTools.find(
        (e) => e.pluginId === context.pluginId && e.tool.name === name,
      )?.tool,
  });
  const deps = {
    store,
    llm,
    hookPipeline: bundle.hookPipeline,
    extensions: bundle.extensions,
    services: bundle.services,
    toolExecutor: executor,
    loadRuntime: async (m) =>
      m.name === providerName
        ? {
            ...bundle.loadedCache.get(storyRuntime)!,
            manifest: m,
            handler: async () => ({ outcome: "success", value: story }),
          }
        : bundle.loadedCache.get(m.name),
  } satisfies TurnExecutorDeps;
  try {
    const execution = await executeTurn(
      {
        sessionId,
        turnId: "synthetic-turn",
        origin: "player",
        locale,
        playerMessage:
          locale === "zh-CN"
            ? "我先不答应。我问：你说的‘我带你去’是什么意思？"
            : "I have not agreed. I ask: what did you mean by ‘I will guide you’?",
      },
      manifests,
      deps,
    );
    const commit = await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: "synthetic-turn", durationMs: 1 },
    });
    const retry = retryWorldIR
      ? await executeTurn(
          {
            sessionId,
            turnId: "synthetic-retry",
            origin: "manual",
            locale,
            playerMessage: "",
            manualTrigger: {
              runtimeId: "world-ir",
              sourceTurnId: "synthetic-turn",
              retrySeedResults: execution.result.runtimeResults.filter(
                (r) => r.status === "success",
              ),
            },
          },
          manifests,
          deps,
        )
      : undefined;
    return {
      commit,
      retry: retry?.result,
      calls,
      results: execution.result.runtimeResults.map((r) => ({
        name: r.runtimeId,
        status: r.status,
        error: r.error,
        output: r.output,
      })),
      messages: await store.listMessages(sessionId),
    };
  } finally {
    await bundle.close();
  }
}
