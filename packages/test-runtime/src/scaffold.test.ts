import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validatePluginLabels } from "@covel/plugin-loader";
import { MockLLM } from "@covel/plugin-test-utils";
import { createMemoryStore } from "@covel/store/memory";
import { createToolExecutor, executeTurn } from "@covel/runtime";
import { createDefaultToolRegistry } from "@covel/tools";
import { createDefaultToolApprovalPipeline } from "@covel/approval";
import { describe, expect, it } from "vitest";
import { runRuntimeCases } from "./runner.js";
import { loadRuntimeBundle } from "./runtime-loading.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// Runs `node` with the arguments and resolves when the child ends. It sets no
// time limit of its own: the test's limit is the only one, and `signal` stops
// the child when the test reaches it.
function runNode(
  args: string[],
  options: { signal: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv },
) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(process.execPath, args, options, (error, stdout, stderr) => {
        if (!error) resolve({ status: 0, stdout, stderr });
        else if (typeof error.code === "number")
          resolve({ status: error.code, stdout, stderr });
        else reject(error);
      });
    },
  );
}

/** Use the generated manifests in a player turn, where stage bindings resolve. */
async function expectNarrativeBinding(pluginsDir: string, pluginId: string) {
  const narrative = "The gatekeeper asks you to return before dawn.";
  const providerId = "fixture-story";
  const providerRoot = path.join(pluginsDir, providerId);
  await mkdir(providerRoot);
  await writeFile(
    path.join(providerRoot, "package.json"),
    JSON.stringify({
      name: providerId,
      version: "1.0.0",
      type: "module",
    }),
  );
  await writeFile(
    path.join(providerRoot, "PLUGIN.md"),
    `---
id: ${providerId}
kind: plugin
version: 1.0.0
description: Provides one narrative for the generated analyst.
provides: [narrative-engine@1]
contracts:
  narrative-engine@1:
    schema: ./output.json
runtime:
  type: function
  schedule:
    stage: narrative
    trigger:
      type: auto
  io:
    output:
      contract: narrative-engine@1
    visibility: plugin
  function:
    handler: ./handler.js
---
`,
  );
  await writeFile(
    path.join(providerRoot, "output.json"),
    JSON.stringify({
      type: "object",
      required: ["narrativeOutput"],
      properties: { narrativeOutput: { type: "string" } },
    }),
  );
  await writeFile(
    path.join(providerRoot, "handler.js"),
    `export default async function () {
      return { outcome: "success", value: { narrativeOutput: ${JSON.stringify(narrative)} } };
    }`,
  );
  const store = createMemoryStore();
  let bundle: Awaited<ReturnType<typeof loadRuntimeBundle>> | undefined;
  let toolExecutor: ReturnType<typeof createToolExecutor> | undefined;
  try {
    bundle = await loadRuntimeBundle({
      pluginsDir,
      pluginId,
      runtimeId: `${pluginId}/analyst`,
      locale: "en",
      withPlugins: [providerId],
      store,
    });
    const sessionId = "fixture-stage-binding";
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
    toolExecutor = createToolExecutor({
      findTool: (name, context) => tools.find(name, context.pluginId),
      getToolSource: (name) => tools.source(name),
      store,
      approval: createDefaultToolApprovalPipeline(),
    });
    const llm = new MockLLM({
      defaultResponse: {
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "done",
            name: "runtime-done",
            arguments: '{"reason":"observed"}',
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    const { result } = await executeTurn(
      {
        sessionId,
        turnId: "fixture-stage-turn",
        playerMessage: "Speak to the gatekeeper.",
        origin: "player",
        locale: "en",
      },
      bundle.manifests,
      {
        store,
        loadRuntime: async (manifest) => bundle!.loadedCache.get(manifest.name),
        llm,
        toolExecutor,
      },
    );
    expect(result.runtimeResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runtimeId: providerId, status: "success" }),
        expect.objectContaining({
          runtimeId: `${pluginId}/analyst`,
          status: "success",
        }),
      ]),
    );
    expect(llm.calls).toHaveLength(1);
    const prompt = JSON.stringify(llm.calls[0]?.messages);
    expect(prompt).toContain("narrator-output");
    expect(prompt).toContain(narrative);
  } finally {
    await toolExecutor?.close();
    await bundle?.close();
    await store.close();
  }
}

describe("plugin scaffolding", () => {
  it.for([
    { mode: "default", args: [], directory: "home/plugins" },
    {
      mode: "custom",
      args: ["-r", "recorder:function,analyst:agent"],
      directory: "user-plugins",
    },
    { mode: "with-tools", args: ["--with-tools"], directory: "plugins" },
    {
      mode: "agent-only",
      args: ["-r", "analyst:agent"],
      directory: "home/plugins",
    },
  ])(
    "runs the generated $mode plugin cases",
    async ({ mode, args, directory }, { signal }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "covel-scaffold-"));
      try {
        await mkdir(path.join(root, "scripts"));
        await cp(
          path.join(repoRoot, "scripts/create-plugin.js"),
          path.join(root, "scripts/create-plugin.js"),
        );
        await cp(
          path.join(repoRoot, "templates"),
          path.join(root, "templates"),
          { recursive: true },
        );
        await cp(
          path.join(repoRoot, "package.json"),
          path.join(root, "package.json"),
        );
        const pluginId = `fixture-${mode}`;
        const created = await runNode(
          ["scripts/create-plugin.js", pluginId, ...args],
          {
            signal,
            cwd: root,
            env: {
              ...process.env,
              COVEL_HOME: path.join(root, "home"),
              COVEL_USER_PLUGINS_DIR:
                mode === "custom" ? path.join(root, directory) : "",
            },
          },
        );
        expect(created.status, created.stderr).toBe(0);
        const pluginRoot = path.join(root, directory, pluginId);
        // A new plugin starts on the current contract: manifests and prompts
        // in English, translated labels in locales/.
        const manifests = (await readdir(pluginRoot, { recursive: true }))
          .filter((file) =>
            /^(PLUGIN|RUNTIME)(\..+)?\.md$/.test(path.basename(file)),
          )
          .sort();
        expect(manifests).toContain("PLUGIN.md");
        // A standalone plugin names the host it was written on; a bundled
        // one ships with its host.
        const rootManifest = await readFile(
          path.join(pluginRoot, "PLUGIN.md"),
          "utf8",
        );
        const { version: hostVersion } = JSON.parse(
          await readFile(path.join(repoRoot, "package.json"), "utf8"),
        ) as { version: string };
        if (mode === "with-tools") expect(rootManifest).not.toMatch(/^covel:/m);
        else expect(rootManifest).toContain(`covel: ">=${hostVersion}"`);
        for (const file of manifests) {
          expect(path.basename(file), file).toMatch(/^(PLUGIN|RUNTIME)\.md$/);
          expect(
            await readFile(path.join(pluginRoot, file), "utf8"),
            file,
          ).not.toMatch(/[\u4e00-\u9fff]/);
        }
        expect(await validatePluginLabels(pluginRoot)).toEqual([]);
        expect(
          await readFile(path.join(pluginRoot, "locales/zh.yaml"), "utf8"),
        ).toMatch(/^PLUGIN\.md:\n {2}description: .*[\u4e00-\u9fff]/m);
        if (mode !== "with-tools") {
          // Plugins scaffolded outside the repo carry no install step: the
          // author SDK is a workspace package, not an npm dependency.
          const manifest = JSON.parse(
            await readFile(path.join(pluginRoot, "package.json"), "utf8"),
          );
          expect(manifest.scripts).toBeUndefined();
          expect(manifest.dependencies).toBeUndefined();
          expect(manifest.devDependencies).toBeUndefined();
        } else {
          await mkdir(path.join(pluginRoot, "node_modules/@covel"), {
            recursive: true,
          });
          await symlink(
            path.join(repoRoot, "packages/plugin-handlers-utils"),
            path.join(pluginRoot, "node_modules/@covel/plugin-handlers-utils"),
            "dir",
          );
          const compiler = path.join(
            repoRoot,
            "packages/test-runtime/node_modules/typescript/bin/tsc",
          );
          const check = () =>
            runNode([compiler, "--noEmit", "-p", pluginRoot], { signal });
          const checked = await check();
          expect(checked.status, checked.stdout + checked.stderr).toBe(0);
          const handlerPath = path.join(pluginRoot, "tools/record-note.js");
          const handlerSource = await readFile(handlerPath, "utf8");
          const invalidSource = handlerSource.replace(
            "params.title",
            "params.missingTitle",
          );
          expect(invalidSource).not.toBe(handlerSource);
          await writeFile(handlerPath, invalidSource, "utf8");
          const rejected = await check();
          expect(rejected.status).not.toBe(0);
          expect(rejected.stdout).toContain("missingTitle");
          await writeFile(handlerPath, handlerSource, "utf8");
        }
        const report = await runRuntimeCases({
          pluginId,
          pluginsDir: path.join(root, directory),
          mode: "mock",
        });
        expect(report.cases.length).toBeGreaterThan(0);
        for (const entry of report.cases) {
          expect(entry.status, JSON.stringify(entry.result.assertions)).toBe(
            "passed",
          );
        }
        if (mode !== "with-tools") {
          await expectNarrativeBinding(path.join(root, directory), pluginId);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
