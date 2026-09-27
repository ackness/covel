import { resolveSessionPlugins } from "@covel/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadPluginSummary,
  loadRuntime,
  loadPluginEntryDefinition,
  pluginDeclarations,
} from "../src/index.js";
let temp: string;
beforeEach(async () => {
  temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "covel-load-")),
  );
});
afterEach(() => fs.rm(temp, { recursive: true, force: true }));
const md = (data: object, body = "Prompt") =>
  `---\n${JSON.stringify(data)}\n---\n${body}`;
async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
async function root(extra: object = {}) {
  await write(
    path.join(temp, "probe/PLUGIN.md"),
    md({ id: "probe", kind: "plugin", description: "Probe", ...extra }),
  );
  return path.join(temp, "probe");
}
const agent = {
  type: "agent",
  schedule: { stage: "narrative", trigger: { type: "auto" } },
};
describe("current package discovery and loading", () => {
  it("loads zero-runtime packages, static prompts and registration declarations without code execution", async () => {
    await root({
      entry: "./throws.js",
      contributes: {
        tools: ["probe"],
        prompt: [{ id: "note", content: "Note", position: "pre-history" }],
      },
    });
    const [d] = await discoverPlugins(temp);
    const definition = await loadPluginDefinition(d!);
    expect(definition.manifests).toEqual([]);
    expect(
      (await loadPluginSummary(d!, undefined, definition)).runtimeCount,
    ).toBe(0);
    await fs.rm(path.join(temp, "probe/PLUGIN.md"));
    expect(
      await loadPluginEntryDefinition(d!, pluginDeclarations(definition)),
    ).toMatchObject({
      entryPaths: ["./throws.js"],
      contributions: { tools: ["probe"] },
      staticPromptSegments: [{ id: "note" }],
    });
  });
  it("loads inline runtime prompt from a frozen parsed definition", async () => {
    await root({ runtime: agent });
    const [d] = await discoverPlugins(temp);
    const definition = await loadPluginDefinition(d!);
    await fs.rm(path.join(temp, "probe/PLUGIN.md"));
    const loaded = await loadRuntime(d!, "probe", undefined, definition);
    expect(loaded.promptTemplate).toBe("Prompt");
    expect(loaded.manifest.name).toBe("probe");
  });
  it("derives child runtime IDs and only inherits root data/settings", async () => {
    await root({
      contributes: {
        settings: [
          { key: "limit", type: "number", label: "Limit", default: 3 },
        ],
      },
    });
    await write(path.join(temp, "probe/runtimes/run/RUNTIME.md"), md(agent));
    const [d] = await discoverPlugins(temp);
    expect(d!.isMultiRuntime).toBe(true);
    const definition = await loadPluginDefinition(d!);
    expect(definition.manifests.map((p) => p.manifest.name)).toEqual([
      "probe/run",
    ]);
    expect(
      (await loadRuntime(d!, "probe/run", undefined, definition)).manifest
        .userSettings?.[0]?.key,
    ).toBe("limit");
  });
  it("rejects old child names instead of discovering a partial package", async () => {
    await root();
    await write(path.join(temp, "probe/runtimes/run/PLUGIN.md"), md(agent));
    await expect(discoverPlugins(temp)).rejects.toThrow("RUNTIME.md");
  });
  it("rejects inline runtime together with a runtime directory", async () => {
    await root({ runtime: agent });
    await write(path.join(temp, "probe/runtimes/run/RUNTIME.md"), md(agent));
    const [d] = await discoverPlugins(temp);
    await expect(loadPluginDefinition(d!)).rejects.toThrow("cannot coexist");
  });
  it("requires a root and matching package identity", async () => {
    await write(path.join(temp, "probe/runtimes/run/RUNTIME.md"), md(agent));
    await expect(discoverPlugins(temp)).rejects.toThrow("root PLUGIN.md");
    await root({ id: "other" });
    const [d] = await discoverPlugins(temp);
    await expect(loadPluginDefinition(d!)).rejects.toThrow("id must match");
  });
  it("checks output contract membership and ambiguity", async () => {
    await root({ provides: ["probe@1"] });
    const child = { ...agent, io: { output: { contract: "other@1" } } };
    await write(path.join(temp, "probe/runtimes/one/RUNTIME.md"), md(child));
    let [d] = await discoverPlugins(temp);
    await expect(loadPluginDefinition(d!)).rejects.toThrow("not declared");
    child.io.output.contract = "probe@1";
    await write(path.join(temp, "probe/runtimes/one/RUNTIME.md"), md(child));
    await write(path.join(temp, "probe/runtimes/two/RUNTIME.md"), md(child));
    [d] = await discoverPlugins(temp);
    await expect(loadPluginDefinition(d!)).rejects.toThrow("ambiguous");
  });
  it("loads contract schemas and validates data contract schema identity", async () => {
    await root({
      contracts: { "data@1": { schema: "./data.json" } },
      contributes: {
        data: {
          records: { version: 1, accepts: ["data@1"], schema: "./data.json" },
        },
      },
    });
    await write(path.join(temp, "probe/data.json"), '{"type":"object"}');
    const [d] = await discoverPlugins(temp);
    expect(
      (await loadPluginDefinition(d!)).packageManifest?.contractSchemas,
    ).toEqual({ "data@1": { type: "object" } });
  });
  it("rejects escaping runtime sources and handler paths", async () => {
    await root({
      runtime: {
        type: "function",
        schedule: { trigger: { type: "manual" } },
        function: { handler: "../outside.js" },
      },
    });
    const [d] = await discoverPlugins(temp);
    await expect(loadRuntime(d!, "probe")).rejects.toThrow("traversal");
  });
  it("rejects handler modules without a callable default export", async () => {
    await root({
      runtime: {
        type: "function",
        schedule: { trigger: { type: "manual" } },
        function: { handler: "./handler.mjs" },
      },
    });
    await write(path.join(temp, "probe/handler.mjs"), "export default 3");
    const [d] = await discoverPlugins(temp);
    await expect(loadRuntime(d!, "probe")).rejects.toThrow("default function");
  });
  it("skips hidden, disabled and non-plugin directories", async () => {
    await write(path.join(temp, ".staged/PLUGIN.md"), md({}));
    await write(path.join(temp, "disabled/PLUGIN.md.disabled"), md({}));
    await fs.mkdir(path.join(temp, "empty"));
    expect(await discoverPlugins(temp)).toEqual([]);
  });
  it("loads all bundled package declarations and their JSON schemas", async () => {
    const all = await discoverPlugins(
      path.resolve(import.meta.dirname, "../../../plugins"),
    );
    expect(all.length).toBeGreaterThan(20);
    for (const d of all)
      await expect(loadPluginDefinition(d)).resolves.toBeDefined();
  });
  it("replaces the real default narrator before applying package conflicts", async () => {
    const discoveries = await discoverPlugins(
      path.resolve(import.meta.dirname, "../../../plugins"),
    );
    const definitions = await Promise.all(
      discoveries.map((discovery) => loadPluginDefinition(discovery)),
    );
    const plan = resolveSessionPlugins({
      requested: ["chat-mode-narrator"],
      plugins: definitions.map(({ plugin }) => ({
        ...plugin,
        source: "builtin" as const,
        authorized: true,
      })),
    });
    expect(plan.active).toContain("chat-mode-narrator");
    expect(plan.active).not.toContain("narrator");
    expect(
      plan.rejected.find((item) => item.pluginId === "narrator")?.code,
    ).toBe("default-replaced");
    expect(
      plan.rejected.filter((item) => item.code !== "default-replaced"),
    ).toEqual([]);
  });
});
