/**
 * The smallest plugins of the authoring guide run in a player turn: one
 * PLUGIN.md with a prompt, and one PLUGIN.md with a handler.js beside it and
 * no package.json.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockLLM } from "@covel/plugin-test-utils";
import { createMemoryStore } from "@covel/store/memory";
import { createToolExecutor, executeTurn } from "@covel/runtime";
import { createDefaultToolRegistry } from "@covel/tools";
import { createDefaultToolApprovalPipeline } from "@covel/approval";
import { afterEach, expect, it } from "vitest";
import { loadRuntimeBundle } from "./runtime-loading.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function runTurn(pluginsDir: string, pluginId: string, llm: MockLLM) {
  const store = createMemoryStore();
  const bundle = await loadRuntimeBundle({
    pluginsDir,
    pluginId,
    runtimeId: pluginId,
    locale: "en",
    store,
  });
  const tools = createDefaultToolRegistry({
    store,
    eventDirectory: {
      async listTopics() {
        return [];
      },
      async validate() {
        return { ok: false, reason: "fixture has no event contracts" };
      },
    },
  });
  const toolExecutor = createToolExecutor({
    findTool: (name, context) => tools.find(name, context.pluginId),
    getToolSource: (name) => tools.source(name),
    store,
    approval: createDefaultToolApprovalPipeline(),
  });
  try {
    const sessionId = "minimal-plugin";
    await store.createSession({
      id: sessionId,
      locale: "en",
      status: "active",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: bundle.pluginIds,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const { result } = await executeTurn(
      {
        sessionId,
        turnId: "minimal-turn",
        playerMessage: "Look around.",
        origin: "player",
        locale: "en",
      },
      bundle.manifests,
      {
        store,
        loadRuntime: async (manifest) => bundle.loadedCache.get(manifest.name),
        llm,
        toolExecutor,
      },
    );
    return result.runtimeResults;
  } finally {
    await toolExecutor.close();
    await bundle.close();
    await store.close();
  }
}

it("runs a plugin that is one PLUGIN.md with a description, a stage and a prompt", async () => {
  const pluginsDir = await mkdtemp(path.join(os.tmpdir(), "covel-minimal-"));
  roots.push(pluginsDir);
  await mkdir(path.join(pluginsDir, "observer"));
  await writeFile(
    path.join(pluginsDir, "observer/PLUGIN.md"),
    `---
description: Adds a short observation after each turn.
runtime:
  schedule: { stage: post-turn }
---
Write one short observation grounded in the latest narrative.
`,
  );
  const llm = new MockLLM({
    defaultResponse: {
      content: null,
      finishReason: "tool_calls",
      toolCalls: [
        { id: "done", name: "runtime-done", arguments: '{"reason":"noted"}' },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  });
  expect(await runTurn(pluginsDir, "observer", llm)).toEqual([
    expect.objectContaining({ runtimeId: "observer", status: "success" }),
  ]);
  expect(JSON.stringify(llm.calls[0]?.messages)).toContain(
    "Write one short observation",
  );
});

it("runs a function plugin whose handler.js sits beside PLUGIN.md without package.json", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "covel-minimal-"));
  roots.push(root);
  const pluginsDir = path.join(root, "plugins");
  await mkdir(path.join(pluginsDir, "tally"), { recursive: true });
  // A CommonJS package above the plugin does not decide its module format.
  await writeFile(
    path.join(pluginsDir, "package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  await writeFile(
    path.join(pluginsDir, "tally/PLUGIN.md"),
    `---
description: Counts turns.
runtime:
  schedule: { stage: post-turn }
  function: {}
---
`,
  );
  await writeFile(
    path.join(pluginsDir, "tally/handler.js"),
    "export default async function () { return { outcome: 'success', value: { counted: 1 } }; }\n",
  );
  expect(await runTurn(pluginsDir, "tally", new MockLLM())).toEqual([
    expect.objectContaining({
      runtimeId: "tally",
      status: "success",
      output: { counted: 1 },
    }),
  ]);
});
