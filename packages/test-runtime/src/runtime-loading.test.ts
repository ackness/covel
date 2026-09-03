import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RuntimeManifest } from "@covel/shared";

import {
  expandPath,
  loadEntryTools,
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

  it("loads entry tools declared only by a multi-runtime root manifest", async () => {
    const rootPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "covel-test-runtime-entry-"),
    );
    try {
      await fs.mkdir(path.join(rootPath, "server"));
      await fs.writeFile(
        path.join(rootPath, "PLUGIN.md"),
        [
          "---",
          "name: plugin",
          "description: Test plugin",
          "pluginType: plugin",
          "entry: ./server/index.js",
          "---",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(rootPath, "server/index.js"),
        [
          "export default function (covel) {",
          "  covel.registerTool(covel.toolkit.tool({",
          '    name: "root-tool",',
          '    description: "Root tool",',
          "    parameters: covel.toolkit.z.object({}),",
          "    execute: async () => ({ ok: true }),",
          "  }));",
          "}",
        ].join("\n"),
      );

      const tools = await loadEntryTools(
        {
          id: "plugin",
          rootPath,
          isMultiRuntime: true,
          pluginMdPaths: [path.join(rootPath, "runtimes/main/PLUGIN.md")],
        },
        [manifest()],
      );

      expect(tools.map((entry) => entry.name)).toEqual(["root-tool"]);
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });
});
