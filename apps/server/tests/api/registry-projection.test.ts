import { describe, expect, it } from "vitest";
import type { PluginRegistryEntry } from "@covel/plugin-loader";
import {
  pluginRuntimeDirectory,
  pluginRuntimeDocumentPath,
} from "../../src/routes/misc-api/registry-projection.js";

const entry: PluginRegistryEntry = {
  id: "example",
  summary: {
    id: "example",
    name: "Example",
    description: "Path projection fixture",
    pluginType: "plugin",
    runtimeCount: 1,
  },
  rootPath: "/plugins/example",
  loadedRuntimes: new Map(),
  status: "registered",
};

describe("registry path projection", () => {
  it("uses the discovered document path for inline and directory runtimes", () => {
    const discovered = {
      ...entry,
      runtimeManifestPaths: {
        example: "/plugins/example/PLUGIN.md",
        "example/check": "/plugins/example/runtimes/check/RUNTIME.md",
      },
    };
    expect(pluginRuntimeDocumentPath(discovered, "example")).toBe(
      "/plugins/example/PLUGIN.md",
    );
    expect(pluginRuntimeDirectory(discovered, "example")).toBe(
      "/plugins/example",
    );
    expect(pluginRuntimeDocumentPath(discovered, "example/check")).toBe(
      "/plugins/example/runtimes/check/RUNTIME.md",
    );
    expect(pluginRuntimeDirectory(discovered, "example/check")).toBe(
      "/plugins/example/runtimes/check",
    );
    expect(
      pluginRuntimeDocumentPath(discovered, "example/missing"),
    ).toBeUndefined();
  });

  it("does not invent a path when discovery metadata is absent", () => {
    for (const runtimeId of ["example", "example/check", "unrelated"]) {
      expect(pluginRuntimeDocumentPath(entry, runtimeId)).toBeUndefined();
      expect(pluginRuntimeDirectory(entry, runtimeId)).toBeUndefined();
    }
  });
});
