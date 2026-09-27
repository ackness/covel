import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pluginDeclarations } from "../src/declarations.js";
import { discoverPlugins } from "../src/discover.js";
import {
  loadPluginSummary,
  loadPluginManifest,
  loadPluginDefinition,
  loadPluginEntryDefinition,
  loadRuntime,
  loadRuntimeUi,
} from "../src/load.js";

const MINIMAL_FRONTMATTER = `---
name: test-plugin
description: A test plugin
stage: narrative
---

You are a test agent.
`;

function makeFrontmatter(overrides: Record<string, unknown>): string {
  const base = {
    name: "test-plugin",
    description: "A test plugin",
    stage: "narrative",
  };
  const merged = { ...base, ...overrides };
  const yaml = Object.entries(merged)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\nYou are a test agent.\n`;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("multi-runtime root diagnostics", () => {
  it("loads a root-only entry/UI package with no runtime", async () => {
    const rootPath = path.join(tmpDir, "test-plugin");
    await fs.mkdir(rootPath);
    await fs.writeFile(
      path.join(rootPath, "PLUGIN.md"),
      "---\nname: test-plugin\ndescription: Package\nentry: ./server.js\nui: {right: [./panel.json]}\n---\n",
      "utf8",
    );
    const [discovery] = await discoverPlugins(tmpDir);
    const definition = await loadPluginDefinition(discovery!);
    expect(definition.manifests).toEqual([]);
    expect(definition.packageManifest?.manifest.entry).toBe("./server.js");
    expect(
      (await loadPluginSummary(discovery!, undefined, definition)).runtimeCount,
    ).toBe(0);
    // Entry discovery consumes the snapshot, not current disk contents.
    await fs.rm(path.join(rootPath, "PLUGIN.md"));
    expect(
      (
        await loadPluginEntryDefinition(
          discovery!,
          pluginDeclarations(definition),
        )
      ).entryPaths,
    ).toEqual(["./server.js"]);
  });

  it("loads package declarations and preserves root entry activation", async () => {
    const rootPath = path.join(tmpDir, "test-plugin");
    const runtimePath = path.join(rootPath, "runtimes", "panel");
    await fs.mkdir(runtimePath, { recursive: true });
    await fs.writeFile(
      path.join(rootPath, "PLUGIN.md"),
      makeFrontmatter({
        stage: undefined,
        entry: "./server/index.js",
        ui: { right: ["./panel.json"] },
        userSettings: [],
        dataSchemas: {},
      }).replace("stage: undefined\n", ""),
      "utf8",
    );
    await fs.writeFile(
      path.join(runtimePath, "PLUGIN.md"),
      makeFrontmatter({ name: "test-plugin/panel" }),
      "utf8",
    );
    const [discovery] = await discoverPlugins(tmpDir);
    const loaded = await loadPluginDefinition(discovery!);
    const manifests = loaded.manifests;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const definition = await loadPluginEntryDefinition(
      discovery!,
      pluginDeclarations(loaded),
    );

    expect(definition.entryPaths).toEqual(["./server/index.js"]);
    expect(manifests.map(({ manifest }) => manifest.name)).toEqual([
      "test-plugin/panel",
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(loaded.packageManifest?.manifest.ui).toEqual({
      right: ["./panel.json"],
    });
  });
});

// ── discoverPlugins ─────────────────────────────────────────────

describe("discoverPlugins", () => {
  it("ignores staged installs until their directory is published", async () => {
    const staged = path.join(tmpDir, ".import-pending");
    await fs.mkdir(staged);
    await fs.writeFile(path.join(staged, "PLUGIN.md"), MINIMAL_FRONTMATTER);
    expect(await discoverPlugins(tmpDir)).toEqual([]);
    await fs.rename(staged, path.join(tmpDir, "ready-plugin"));
    expect((await discoverPlugins(tmpDir)).map((entry) => entry.id)).toEqual([
      "ready-plugin",
    ]);
  });
  it("discovers a single-runtime plugin", async () => {
    const pluginDir = path.join(tmpDir, "my-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);

    const results = await discoverPlugins(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "my-plugin",
      rootPath: pluginDir,
      isMultiRuntime: false,
    });
    expect(results[0].pluginMdPaths).toHaveLength(1);
    expect(results[0].pluginMdPaths[0]).toBe(path.join(pluginDir, "PLUGIN.md"));
  });

  it("discovers a multi-runtime plugin", async () => {
    const pluginDir = path.join(tmpDir, "multi-plugin");
    await fs.mkdir(path.join(pluginDir, "runtimes", "rt-a"), {
      recursive: true,
    });
    await fs.mkdir(path.join(pluginDir, "runtimes", "rt-b"), {
      recursive: true,
    });
    // Root PLUGIN.md in multi-runtime is a human doc, not a runtime
    await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);
    await fs.writeFile(
      path.join(pluginDir, "runtimes", "rt-a", "PLUGIN.md"),
      makeFrontmatter({ name: "rt-a", description: "Runtime A" }),
    );
    await fs.writeFile(
      path.join(pluginDir, "runtimes", "rt-b", "PLUGIN.md"),
      makeFrontmatter({ name: "rt-b", description: "Runtime B" }),
    );

    const results = await discoverPlugins(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].isMultiRuntime).toBe(true);
    expect(results[0].pluginMdPaths).toHaveLength(2);
    const names = results[0].pluginMdPaths.map((p) =>
      path.basename(path.dirname(p)),
    );
    expect(names.sort()).toEqual(["rt-a", "rt-b"]);
  });

  it("discovers mixed directory with single and multi-runtime plugins", async () => {
    // Single-runtime
    const singleDir = path.join(tmpDir, "single");
    await fs.mkdir(singleDir, { recursive: true });
    await fs.writeFile(path.join(singleDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);

    // Multi-runtime
    const multiDir = path.join(tmpDir, "multi");
    await fs.mkdir(path.join(multiDir, "runtimes", "rt-x"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(multiDir, "runtimes", "rt-x", "PLUGIN.md"),
      makeFrontmatter({ name: "rt-x", description: "Runtime X" }),
    );

    const results = await discoverPlugins(tmpDir);

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(["multi", "single"]);
  });

  it("returns empty array for empty directory", async () => {
    const results = await discoverPlugins(tmpDir);
    expect(results).toEqual([]);
  });

  it("skips subdirectories without PLUGIN.md", async () => {
    const noPluginDir = path.join(tmpDir, "no-plugin");
    await fs.mkdir(noPluginDir, { recursive: true });
    await fs.writeFile(path.join(noPluginDir, "README.md"), "# Not a plugin");

    const results = await discoverPlugins(tmpDir);
    expect(results).toEqual([]);
  });

  it("skips disabled plugins (PLUGIN.md.disabled)", async () => {
    const pluginDir = path.join(tmpDir, "disabled-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md.disabled"),
      MINIMAL_FRONTMATTER,
    );

    const results = await discoverPlugins(tmpDir);
    expect(results).toEqual([]);
  });
});

describe("bundled plugin dataSchemas", () => {
  it("points every built-in dataSchema declaration at an existing JSON file", async () => {
    const pluginsRoot = path.resolve(import.meta.dirname, "../../../plugins");
    const discoveries = await discoverPlugins(pluginsRoot);
    const seen: string[] = [];

    for (const discovery of discoveries) {
      const manifests = await loadPluginManifest(discovery);
      for (const parsed of manifests) {
        for (const [namespace, decl] of Object.entries(
          parsed.manifest.dataSchemas ?? {},
        )) {
          seen.push(`${discovery.id}/${namespace}`);
          const schemaPath = path.resolve(discovery.rootPath, decl.schema);
          const relative = path.relative(discovery.rootPath, schemaPath);
          expect(relative.startsWith("..")).toBe(false);
          expect(path.isAbsolute(relative)).toBe(false);
          JSON.parse(await fs.readFile(schemaPath, "utf-8"));
        }
      }
    }

    expect(seen.sort()).toEqual([
      "affinity/affinity",
      "char-creator/characters",
      "char-creator/characters",
      "character-blueprint/blueprints",
      "character-blueprint/characters",
      "character-presence/assets",
      "character-presence/presence",
      "core-quest/quests",
      "inventory/items",
      "living-world-rules/rules",
      "scene-stage/assets",
      "scene-stage/scenes",
      "tabletop-rules/rules",
    ]);
  });
});

// ── loadPluginSummary ───────────────────────────────────────────

describe("loadPluginSummary", () => {
  it("loads summary for single-runtime plugin", async () => {
    const pluginDir = path.join(tmpDir, "summary-single");
    await fs.mkdir(pluginDir, { recursive: true });
    const fm = makeFrontmatter({
      name: "summary-single",
      description: "Summary test",
      pluginType: "core-plugin",
      tags: ["mode:dialogue", "role:narrator"],
      relations: { provides: ["narrative-engine"] },
    });
    await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), fm);

    const [discovery] = await discoverPlugins(tmpDir);
    const summary = await loadPluginSummary(discovery);

    expect(summary).toMatchObject({
      id: "summary-single",
      name: "summary-single",
      description: "Summary test",
      pluginType: "core-plugin",
      runtimeCount: 1,
      tags: ["mode:dialogue", "role:narrator"],
      relations: { provides: ["narrative-engine"] },
    });
  });

  it("loads i18n displayName from the root summary", async () => {
    const pluginDir = path.join(tmpDir, "summary-display");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      makeFrontmatter({
        name: "summary-display",
        displayName: { "zh-CN": "行动引导", "en-US": "Action Guide" },
        description: "x",
      }),
    );

    const [discovery] = await discoverPlugins(tmpDir);
    const summary = await loadPluginSummary(discovery);

    expect(summary.displayName).toEqual({
      "zh-CN": "行动引导",
      "en-US": "Action Guide",
    });
  });

  it("leaves displayName undefined when the frontmatter omits it", async () => {
    const pluginDir = path.join(tmpDir, "summary-nodisplay");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      makeFrontmatter({ name: "summary-nodisplay", description: "x" }),
    );

    const [discovery] = await discoverPlugins(tmpDir);
    const summary = await loadPluginSummary(discovery);

    expect(summary.displayName).toBeUndefined();
  });

  it("loads summary for multi-runtime plugin from root PLUGIN.md", async () => {
    const pluginDir = path.join(tmpDir, "summary-multi");
    await fs.mkdir(path.join(pluginDir, "runtimes", "rt-a"), {
      recursive: true,
    });
    await fs.mkdir(path.join(pluginDir, "runtimes", "rt-b"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      makeFrontmatter({
        name: "summary-multi",
        description: "Multi summary",
        pluginType: "core-plugin",
        stage: undefined,
      }).replace("stage: undefined\n", ""),
    );
    await fs.writeFile(
      path.join(pluginDir, "runtimes", "rt-a", "PLUGIN.md"),
      makeFrontmatter({ name: "summary-multi/rt-a", description: "Runtime A" }),
    );
    await fs.writeFile(
      path.join(pluginDir, "runtimes", "rt-b", "PLUGIN.md"),
      makeFrontmatter({ name: "summary-multi/rt-b", description: "Runtime B" }),
    );

    const [discovery] = await discoverPlugins(tmpDir);
    const summary = await loadPluginSummary(discovery);

    expect(summary.id).toBe("summary-multi");
    expect(summary.name).toBe("summary-multi");
    expect(summary.description).toBe("Multi summary");
    expect(summary.runtimeCount).toBe(2);
  });
});

// ── loadPluginManifest ──────────────────────────────────────────

describe("loadPluginManifest", () => {
  it("returns array with 1 ParsedPluginMd for single-runtime", async () => {
    const pluginDir = path.join(tmpDir, "test-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);

    const [discovery] = await discoverPlugins(tmpDir);
    const manifests = await loadPluginManifest(discovery);

    expect(manifests).toHaveLength(1);
    expect(manifests[0].manifest.name).toBe("test-plugin");
    expect(manifests[0].promptTemplate).toContain("You are a test agent.");
  });

  it("returns array with N ParsedPluginMd for multi-runtime", async () => {
    const pluginDir = path.join(tmpDir, "manifest-multi");
    await fs.mkdir(path.join(pluginDir, "runtimes", "rt-a"), {
      recursive: true,
    });
    await fs.mkdir(path.join(pluginDir, "runtimes", "rt-b"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(pluginDir, "runtimes", "rt-a", "PLUGIN.md"),
      makeFrontmatter({
        name: "manifest-multi/rt-a",
        description: "Runtime A",
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "runtimes", "rt-b", "PLUGIN.md"),
      makeFrontmatter({
        name: "manifest-multi/rt-b",
        description: "Runtime B",
      }),
    );

    const [discovery] = await discoverPlugins(tmpDir);
    const manifests = await loadPluginManifest(discovery);

    expect(manifests).toHaveLength(2);
    const names = manifests.map((m) => m.manifest.name).sort();
    expect(names).toEqual(["manifest-multi/rt-a", "manifest-multi/rt-b"]);
  });
});

// ── loadRuntime ─────────────────────────────────────────────────

describe("loadRuntime", () => {
  it("loads logical runtime IDs from their discovered directory and rejects escaped source paths", async () => {
    const rootPath = path.join(tmpDir, "probe");
    const implementation = path.join(rootPath, "runtimes", "implementation");
    await fs.mkdir(implementation, { recursive: true });
    await fs.writeFile(
      path.join(rootPath, "PLUGIN.md"),
      "---\nname: probe\ndescription: Package\nuserSettings: [{key: limit, type: number, label: Limit, default: 3}]\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(implementation, "PLUGIN.md"),
      "---\nname: probe/logical\ndescription: Runtime\nruntimeType: function\nhandler: ./handler.mjs\ntrigger: {type: manual}\nui: {right: [./panel.json]}\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(implementation, "handler.mjs"),
      "export default async () => ({status: 'success'});",
      "utf8",
    );
    await fs.writeFile(
      path.join(implementation, "panel.json"),
      '{"id":"local-panel","view":{"component":"Text"}}',
      "utf8",
    );
    const [discovery] = await discoverPlugins(tmpDir);
    const definition = await loadPluginDefinition(discovery!);
    const loaded = await loadRuntime(
      discovery!,
      "probe/logical",
      undefined,
      definition,
    );
    expect(loaded.handler).toBeTypeOf("function");
    expect(loaded.manifest.userSettings?.[0]?.default).toBe(3);
    expect(
      (await loadRuntimeUi(discovery!, "probe/logical", undefined, definition))
        .uiSpecs?.right?.[0]?.id,
    ).toBe("local-panel");
    expect((await loadRuntime(discovery!, "probe/logical")).handler).toBeTypeOf(
      "function",
    );
    const outside = path.join(tmpDir, "outside.md");
    await fs.writeFile(outside, "private", "utf8");
    await expect(
      loadRuntime(discovery!, "probe/logical", undefined, {
        ...definition,
        manifests: [{ ...definition.manifests[0]!, sourcePath: outside }],
      }),
    ).rejects.toThrow("path traversal rejected");
  });

  it("rejects a function handler module whose default export is not a function", async () => {
    const pluginDir = path.join(tmpDir, "invalid-handler");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      makeFrontmatter({
        runtimeType: "function",
        handler: "./handler.mjs",
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "handler.mjs"),
      "export default { run: true };\n",
    );

    const [discovery] = await discoverPlugins(tmpDir);
    await expect(loadRuntime(discovery, "test-plugin")).rejects.toThrow(
      'Handler module "./handler.mjs" does not export a default function (got object)',
    );
  });

  it("loads prompt template", async () => {
    const pluginDir = path.join(tmpDir, "runtime-refs");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);

    const [discovery] = await discoverPlugins(tmpDir);
    const loaded = await loadRuntime(discovery, "test-plugin");

    expect(loaded.manifest.name).toBe("test-plugin");
    expect(loaded.promptTemplate).toContain("You are a test agent.");
  });

  it("loads output schema when present", async () => {
    const pluginDir = path.join(tmpDir, "runtime-schema");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);
    const schema = {
      type: "object",
      properties: { result: { type: "string" } },
    };
    await fs.writeFile(
      path.join(pluginDir, "output.schema.json"),
      JSON.stringify(schema),
    );

    const [discovery] = await discoverPlugins(tmpDir);
    const loaded = await loadRuntime(discovery, "test-plugin");

    expect(loaded.outputSchema).toEqual(schema);
  });

  it("handles missing schema gracefully", async () => {
    const pluginDir = path.join(tmpDir, "runtime-bare");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);

    const [discovery] = await discoverPlugins(tmpDir);
    const loaded = await loadRuntime(discovery, "test-plugin");

    expect(loaded.outputSchema).toBeUndefined();
  });
});
