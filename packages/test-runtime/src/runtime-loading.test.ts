import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginDiscoveryResult } from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";

import { createMemoryStore } from "@covel/store";
import {
  expandPath,
  loadLocalTools,
  pluginIdFromRuntime,
  prepareRuntimeManifests,
} from "./runtime-loading.js";

function manifest(patch: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: "plugin/main",
    pluginId: "plugin",
    description: "Main runtime",
    needs: ["plugin/upstream"],
    ...patch,
  };
}

function discovery(rootPath: string): PluginDiscoveryResult {
  return {
    id: "plugin",
    rootPath,
    isMultiRuntime: false,
    pluginMdPaths: [path.join(rootPath, "PLUGIN.md")],
    source: "builtin",
  };
}

describe("test-runtime runtime loading helpers", () => {
  it("derives plugin ids and expands shell-style paths", () => {
    expect(pluginIdFromRuntime("plugin/main")).toBe("plugin");
    expect(pluginIdFromRuntime("single")).toBe("single");
    expect(expandPath("~")).toBe(os.homedir());
    expect(expandPath("~/plugins")).toBe(path.join(os.homedir(), "plugins"));
    expect(path.isAbsolute(expandPath("plugins"))).toBe(true);
  });

  it("prepares manifests without mutating upstream requirements", () => {
    const raw = [manifest()];
    const prepared = prepareRuntimeManifests({
      rawManifests: raw,
      runtimeId: "plugin/main",
      pluginId: "plugin",
      ignoreUpstreams: true,
    });

    expect(prepared.target.name).toBe("plugin/main");
    expect(prepared.manifests[0]?.needs).toBeUndefined();
    expect(raw[0]?.needs).toEqual(["plugin/upstream"]);
  });

  it("throws clear errors for missing target runtimes", () => {
    expect(() =>
      prepareRuntimeManifests({
        rawManifests: [manifest()],
        runtimeId: "plugin/missing",
        pluginId: "plugin",
      }),
    ).toThrow('runtime "plugin/missing" not found in plugin "plugin"');
  });

  it("loads local tool factories from plugin-relative paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-tools-"));
    fs.writeFileSync(
      path.join(root, "tools.js"),
      [
        "export default ({ tool, z }) => tool({",
        '  name: "local_echo",',
        '  description: "Echo local values",',
        "  parameters: z.object({ value: z.string() }),",
        "  async execute(params) { return params; },",
        "});",
      ].join("\n"),
    );

    const store = createMemoryStore();
    const tools = await loadLocalTools(
      discovery(root),
      [manifest({ tools: { local: ["tools.js"] } })],
      store,
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("local_echo");
    await expect(
      tools[0]?.execute(
        { value: "ok" },
        {
          sessionId: "session",
          turnId: "turn",
          pluginId: "plugin",
          runtimeId: "plugin/main",
        },
      ),
    ).resolves.toEqual({ value: "ok" });
  });

  it("injects the same helper surface that server bootstrap gives local tools", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-tools-"));
    fs.writeFileSync(
      path.join(root, "tools.js"),
      [
        "export default ({ tool, z, shortId, shortIdBatch, withPendingProposals, store }) => tool({",
        '  name: "record-note",',
        '  description: "Record note",',
        "  parameters: z.object({ title: z.string() }),",
        "  async execute(params, context) {",
        "    const key = shortId('note', params.title, context.sessionId);",
        "    const batch = shortIdBatch('tag', ['alpha', 'alpha'], context.sessionId);",
        "    return withPendingProposals({ key, batch, hasStore: Boolean(store) }, []);",
        "  },",
        "});",
      ].join("\n"),
    );

    const store = createMemoryStore();
    const tools = await loadLocalTools(
      discovery(root),
      [manifest({ tools: { local: ["tools.js"] } })],
      store,
    );

    expect(tools).toHaveLength(1);
    await expect(
      tools[0]?.execute(
        { title: "Opened Vault" },
        {
          sessionId: "session",
          turnId: "turn",
          pluginId: "plugin",
          runtimeId: "plugin/main",
        },
      ),
    ).resolves.toEqual({
      key: "note-opened-vault",
      batch: ["tag-alpha", "tag-alpha-2"],
      hasStore: true,
    });
  });

  it("rejects local tool paths outside the plugin root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-tools-"));

    await expect(
      loadLocalTools(discovery(root), [
        manifest({ tools: { local: ["../outside.js"] } }),
      ]),
    ).rejects.toThrow("tools.local path escapes plugin root: ../outside.js");
  });

  it("rejects missing local tool files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-tools-"));

    await expect(
      loadLocalTools(discovery(root), [
        manifest({ tools: { local: ["missing.js"] } }),
      ]),
    ).rejects.toThrow(
      `tools.local file not found: ${path.join(root, "missing.js")}`,
    );
  });
});
