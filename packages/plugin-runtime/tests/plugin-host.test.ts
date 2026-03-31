import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPluginHost } from "../src/host/plugin-host.js";

function minimalManifest(id: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0",
    id,
    displayName: id,
    version: "0.1.0",
    author: "test",
    description: "desc",
    defaultLocale: "zh-CN",
    supportedLocales: ["zh-CN"],
    ...extra,
  };
}

describe("plugin-host", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "plugin-host-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads plugins from a directory", async () => {
    const pluginDir = join(tempDir, "my-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify(minimalManifest("my-plugin"))
    );

    const host = createPluginHost();
    const loaded = await host.loadFromDirectory(tempDir);

    expect(loaded).toHaveLength(1);
    expect(host.pluginRegistry.has("my-plugin")).toBe(true);
  });

  it("loads plugins in loadingOrder", async () => {
    for (const [name, order] of [["plugin-b", 20], ["plugin-a", 10]] as const) {
      const dir = join(tempDir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "plugin.json"),
        JSON.stringify(minimalManifest(name, { loadingOrder: order }))
      );
    }

    const host = createPluginHost();
    const loaded = await host.loadFromDirectory(tempDir);

    expect(loaded).toHaveLength(2);
    // plugin-a (order 10) should load first
    expect(loaded[0].manifest.id).toBe("plugin-a");
    expect(loaded[1].manifest.id).toBe("plugin-b");
  });

  it("skips plugins with unmet dependencies", async () => {
    const dir = join(tempDir, "dependent");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify(
        minimalManifest("dependent", { requires: ["missing-dep"] })
      )
    );

    const host = createPluginHost();
    const loaded = await host.loadFromDirectory(tempDir);

    expect(loaded).toHaveLength(0);
  });

  it("registers runtimes from manifest", async () => {
    const dir = join(tempDir, "rt-plugin");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify(
        minimalManifest("rt-plugin", {
          runtimes: [
            {
              id: "main",
              pluginId: "rt-plugin",
              kind: "plugin",
              phase: "post_story",
              trigger: { mode: "always" },
              tools: [],
              hooks: [],
            },
          ],
        })
      )
    );

    const host = createPluginHost();
    await host.loadFromDirectory(tempDir);

    const runtimes = host.runtimeRegistry.listByPlugin("rt-plugin");
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].spec.kind).toBe("plugin");
  });

  it("loads server module and registers tools", async () => {
    const dir = join(tempDir, "tool-plugin");
    await mkdir(join(dir, "server"), { recursive: true });
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify(
        minimalManifest("tool-plugin", {
          tools: [{ id: "my-tool", kind: "query" }],
        })
      )
    );
    // Write a server module
    await writeFile(
      join(dir, "server", "index.js"),
      `export default function register(registrar) {
        registrar.addTool("my-tool", async (ctx) => ({ output: "hello" }));
      }`
    );

    const host = createPluginHost();
    await host.loadFromDirectory(tempDir);

    const tool = host.toolRegistry.get("tool-plugin", "my-tool");
    expect(tool).toBeDefined();
    expect(tool!.definition.kind).toBe("query");
  });

  it("resolves PLUGIN.md as instructions path", async () => {
    const dir = join(tempDir, "instr-plugin");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify(
        minimalManifest("instr-plugin", {
          runtimes: [
            {
              id: "main",
              pluginId: "instr-plugin",
              kind: "plugin",
              phase: "post_story",
              trigger: { mode: "always" },
              tools: [],
              hooks: [],
            },
          ],
        })
      )
    );
    await writeFile(join(dir, "PLUGIN.md"), "# Instructions\nDo things.");

    const host = createPluginHost();
    await host.loadFromDirectory(tempDir);

    const rt = host.runtimeRegistry.get("instr-plugin", "main");
    expect(rt?.instructionsPath).toBe(join(dir, "PLUGIN.md"));
  });
});
