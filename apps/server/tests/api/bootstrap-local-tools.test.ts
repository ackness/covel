import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ParsedPluginMd,
  PluginDiscoveryResult,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import {
  buildPluginToolAccess,
  createBootstrapLocalTools,
  createLocalToolLoader,
} from "../../src/routes/api/bootstrap/local-tools.js";

const tempRoots: string[] = [];

function parsedManifest(
  patch: Partial<RuntimeManifest> & Pick<RuntimeManifest, "name">,
): ParsedPluginMd {
  return {
    manifest: {
      pluginId: patch.name.split("/")[0] ?? patch.name,
      description: "test runtime",
      ...patch,
    } as RuntimeManifest,
    promptTemplate: "",
    rawFrontmatter: {},
  };
}

function discovery(
  id: string,
  rootPath: string,
  source: PluginDiscoveryResult["source"],
): PluginDiscoveryResult {
  return {
    id,
    rootPath,
    isMultiRuntime: false,
    pluginMdPaths: [path.join(rootPath, "PLUGIN.md")],
    source,
  };
}

async function makePluginRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "covel-bootstrap-tools-"));
  tempRoots.push(root);
  await writeFile(path.join(root, "PLUGIN.md"), "---\nname: test\n---\n");
  return root;
}

async function writeFactoryTool(
  root: string,
  fileName: string,
  toolName: string,
): Promise<void> {
  await writeFile(
    path.join(root, fileName),
    [
      "export default ({ tool, z }) => tool({",
      `  name: ${JSON.stringify(toolName)},`,
      `  description: ${JSON.stringify(`Tool ${toolName}`)},`,
      "  parameters: z.object({ value: z.string().optional() }),",
      "  async execute(params) { return { value: params.value ?? 'ok' }; },",
      "});",
    ].join("\n"),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("bootstrap local tools", () => {
  it("seeds per-plugin tool access from builtin names only — local/plugin declarations grant nothing until registration succeeds (audit A-01)", () => {
    const access = buildPluginToolAccess(
      new Map([
        [
          "plugin-a",
          [
            parsedManifest({
              name: "plugin-a/main",
              tools: {
                builtin: ["plugin-data-get"],
                local: ["tools/unlock-door.ts", "roll.mjs"],
                plugin: ["entry-declared-tool"],
              },
            }),
          ],
        ],
      ]),
    );

    expect([...(access.get("plugin-a") ?? [])].sort()).toEqual([
      "plugin-data-get",
    ]);
  });

  it("loads plugin-local tool factories with the bootstrap injection context", async () => {
    const root = await makePluginRoot();
    await writeFactoryTool(root, "tools.mjs", "tools");

    const loader = createLocalToolLoader({
      discoveryMap: new Map([
        ["plugin-a", discovery("plugin-a", root, "builtin")],
      ]),
      manifestCache: new Map([
        [
          "plugin-a",
          [
            parsedManifest({
              name: "plugin-a/main",
              tools: { local: ["tools.mjs"] },
            }),
          ],
        ],
      ]),
      store: createMemoryStore(),
    });

    const tools = await loader("plugin-a");
    expect(tools.map((item) => item.name)).toEqual(["tools"]);
    await expect(
      tools[0]?.execute(
        { value: "loaded" },
        {
          sessionId: "session",
          turnId: "turn",
          pluginId: "plugin-a",
          runtimeId: "plugin-a/main",
        },
      ),
    ).resolves.toEqual({ value: "loaded" });
  });

  it("skips local tool paths that escape the plugin root", async () => {
    const root = await makePluginRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const loader = createLocalToolLoader({
      discoveryMap: new Map([
        ["plugin-a", discovery("plugin-a", root, "builtin")],
      ]),
      manifestCache: new Map([
        [
          "plugin-a",
          [
            parsedManifest({
              name: "plugin-a/main",
              tools: { local: ["../outside.mjs"] },
            }),
          ],
        ],
      ]),
      store: createMemoryStore(),
    });

    await expect(loader("plugin-a")).resolves.toEqual([]);
    expect(warn.mock.calls[0]?.[0]).toContain("escapes the plugin root");
  });

  it("skips missing local tool files with a clear warning", async () => {
    const root = await makePluginRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const loader = createLocalToolLoader({
      discoveryMap: new Map([
        ["plugin-a", discovery("plugin-a", root, "builtin")],
      ]),
      manifestCache: new Map([
        [
          "plugin-a",
          [
            parsedManifest({
              name: "plugin-a/main",
              tools: { local: ["missing.mjs"] },
            }),
          ],
        ],
      ]),
      store: createMemoryStore(),
    });

    await expect(loader("plugin-a")).resolves.toEqual([]);
    expect(warn.mock.calls[0]?.[0]).toContain("tool file not found");
  });

  it("eager-loads trusted local tools and lazily activates community tools", async () => {
    const builtinRoot = await makePluginRoot();
    const communityRoot = await makePluginRoot();
    await writeFactoryTool(builtinRoot, "builtin-tool.mjs", "builtin-tool");
    await writeFactoryTool(
      communityRoot,
      "community-tool.mjs",
      "community-tool",
    );

    const toolMap = new Map();
    const localToolNames = new Set<string>();
    const localTools = await createBootstrapLocalTools({
      discoveryMap: new Map([
        ["builtin-plugin", discovery("builtin-plugin", builtinRoot, "builtin")],
        [
          "community-plugin",
          discovery("community-plugin", communityRoot, "community"),
        ],
      ]),
      manifestCache: new Map([
        [
          "builtin-plugin",
          [
            parsedManifest({
              name: "builtin-plugin/main",
              tools: { local: ["builtin-tool.mjs"] },
            }),
          ],
        ],
        [
          "community-plugin",
          [
            parsedManifest({
              name: "community-plugin/main",
              tools: { local: ["community-tool.mjs"] },
            }),
          ],
        ],
      ]),
      store: createMemoryStore(),
      toolMap,
      localToolNames,
    });

    expect(toolMap.has("builtin-tool")).toBe(true);
    expect(toolMap.has("community-tool")).toBe(false);
    expect(localToolNames.has("builtin-tool")).toBe(true);
    // Access is granted at registration time, not from the declaration —
    // the community tool isn't loaded yet, so it isn't authorized yet.
    expect(
      localTools.pluginToolAccess.get("builtin-plugin")?.has("builtin-tool"),
    ).toBe(true);
    expect(
      localTools.pluginToolAccess
        .get("community-plugin")
        ?.has("community-tool"),
    ).toBeFalsy();

    await localTools.activatePluginLocalTools("community-plugin");

    expect(toolMap.has("community-tool")).toBe(true);
    expect(localToolNames.has("community-tool")).toBe(true);
    expect(
      localTools.pluginToolAccess
        .get("community-plugin")
        ?.has("community-tool"),
    ).toBe(true);
  });

  it("a name collision never authorizes the declaring plugin to run the victim's tool (audit A-01)", async () => {
    const victimRoot = await makePluginRoot();
    const attackerRoot = await makePluginRoot();
    // Same tool name from both plugins — victim registers first (builtin),
    // attacker's community copy collides and is skipped.
    await writeFactoryTool(victimRoot, "shared-tool.mjs", "shared-tool");
    await writeFactoryTool(attackerRoot, "shared-tool.mjs", "shared-tool");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const toolMap = new Map();
    const localToolNames = new Set<string>();
    const localTools = await createBootstrapLocalTools({
      discoveryMap: new Map([
        ["victim", discovery("victim", victimRoot, "builtin")],
        ["attacker", discovery("attacker", attackerRoot, "community")],
      ]),
      manifestCache: new Map([
        [
          "victim",
          [
            parsedManifest({
              name: "victim/main",
              tools: { local: ["shared-tool.mjs"] },
            }),
          ],
        ],
        [
          "attacker",
          [
            parsedManifest({
              name: "attacker/main",
              // Declares the victim's tool name both ways — neither may grant access.
              tools: { local: ["shared-tool.mjs"], plugin: ["shared-tool"] },
            }),
          ],
        ],
      ]),
      store: createMemoryStore(),
      toolMap,
      localToolNames,
    });

    await localTools.activatePluginLocalTools("attacker");

    expect(warn.mock.calls.some(([msg]) => msg.includes("collides"))).toBe(
      true,
    );
    expect(localTools.pluginToolAccess.get("victim")?.has("shared-tool")).toBe(
      true,
    );
    // The attacker must not be able to resolve the victim's implementation.
    expect(
      localTools.pluginToolAccess.get("attacker")?.has("shared-tool"),
    ).toBeFalsy();
  });
});
