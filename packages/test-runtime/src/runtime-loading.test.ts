import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { loadPluginDefinition } from "@covel/plugin-loader";
import { PluginServiceRegistry } from "@covel/runtime";
import { z } from "@covel/tools";

import {
  expandPath,
  defaultPluginsDir,
  loadEntryTools,
  loadRuntimeBundle,
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
  afterEach(() => vi.unstubAllEnvs());

  it("resolves the configured user plugin directory before home defaults", () => {
    vi.stubEnv("COVEL_USER_PLUGINS_DIR", "");
    vi.stubEnv("COVEL_HOME", "");
    expect(defaultPluginsDir()).toBe(path.join(os.homedir(), ".covel/plugins"));
    vi.stubEnv("COVEL_HOME", "custom-home");
    expect(defaultPluginsDir()).toBe(path.resolve("custom-home/plugins"));
    vi.stubEnv("COVEL_USER_PLUGINS_DIR", "custom-plugins");
    expect(defaultPluginsDir()).toBe(path.resolve("custom-plugins"));
  });

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
          '  if ("store" in covel.toolkit) throw new Error("Unexpected activation store");',
          '  covel.registerFormValidator("check", async () => undefined);',
          "  covel.registerTool(covel.toolkit.tool({",
          '    name: "root-tool",',
          '    description: "Root tool",',
          "    parameters: covel.toolkit.z.object({}),",
          "    execute: async () => ({ ok: true }),",
          "  }));",
          "}",
        ].join("\n"),
      );

      const discovery = {
        id: "plugin",
        rootPath,
        isMultiRuntime: true,
        pluginMdPaths: [path.join(rootPath, "runtimes/main/PLUGIN.md")],
      };
      await fs.mkdir(path.join(rootPath, "runtimes/main"), { recursive: true });
      await fs.writeFile(
        discovery.pluginMdPaths[0]!,
        "---\nname: plugin/main\ndescription: Main\ntrigger: {type: manual}\n---\n",
        "utf8",
      );
      const entry = await loadEntryTools(
        discovery,
        await loadPluginDefinition(discovery),
      );

      expect(entry.tools.map((tool) => tool.name)).toEqual(["root-tool"]);
      await entry.close();
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });
  it("shares package declarations with runtimes whose logical IDs differ from their directories", async () => {
    const pluginsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "covel-harness-package-"),
    );
    const root = path.join(pluginsDir, "probe");
    try {
      await fs.mkdir(path.join(root, "runtimes/main"), { recursive: true });
      await fs.writeFile(
        path.join(root, "PLUGIN.md"),
        `---
name: probe
description: Package
userSettings:
  - key: mode
    type: text
    label: Mode
    default: brief
dataSchemas:
  notes:
    schema: ./schemas/notes.json
    schemaVersion: 1
    acceptsWorldData: false
---
`,
        "utf8",
      );
      await fs.mkdir(path.join(root, "schemas"));
      await fs.writeFile(
        path.join(root, "schemas/notes.json"),
        '{"type":"object"}',
        "utf8",
      );
      await fs.writeFile(
        path.join(root, "runtimes/main/PLUGIN.md"),
        `---
name: probe/logical
description: Main
runtimeType: function
handler: ./handler.js
trigger: {type: manual}
---
`,
        "utf8",
      );
      await fs.writeFile(
        path.join(root, "runtimes/main/handler.js"),
        'export default async () => ({outcome: "success", value: {}});',
        "utf8",
      );
      const bundle = await loadRuntimeBundle({
        pluginsDir,
        pluginId: "probe",
        runtimeId: "probe/logical",
        locale: "zh-CN",
      });
      expect(bundle.target.userSettings?.[0]?.default).toBe("brief");
      expect(bundle.target.dataSchemas?.notes.schema).toBe(
        "./schemas/notes.json",
      );
      expect(
        bundle.loadedCache.get("probe/logical")?.manifest.userSettings,
      ).toEqual(bundle.target.userSettings);
      expect(
        bundle.loadedCache.get("probe/logical")?.manifest.dataSchemas,
      ).toEqual(bundle.target.dataSchemas);
      await bundle.close();
    } finally {
      await fs.rm(pluginsDir, { recursive: true, force: true });
    }
  });

  it.each(["create-form", "memory-search", "search-tools", "duplicate"])(
    "rejects invalid %s registration even when its factory catches errors",
    async (name) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "covel-harness-tools-"),
      );
      try {
        await fs.writeFile(
          path.join(root, "PLUGIN.md"),
          "---\nname: probe\ndescription: Probe\nentry: ./entry.js\n---\n",
          "utf8",
        );
        const registration = `covel.registerTool(covel.toolkit.tool({ name: "${name}", description: "Fixture", parameters: covel.toolkit.z.object({}), execute: async () => ({}) }));`;
        await fs.writeFile(
          path.join(root, "entry.js"),
          `export default (covel) => { try { ${registration} ${name === "duplicate" ? registration : ""} } catch {} };`,
          "utf8",
        );
        const discovery = {
          id: "probe",
          rootPath: root,
          isMultiRuntime: false,
          pluginMdPaths: [path.join(root, "PLUGIN.md")],
        };
        await expect(
          loadEntryTools(discovery, await loadPluginDefinition(discovery)),
        ).rejects.toThrow(
          name === "duplicate" ? "already registered" : "reserved",
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects an entry symlink outside the plugin root before importing it", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "covel-harness-symlink-"),
    );
    const root = path.join(directory, "plugin");
    try {
      await fs.mkdir(root);
      await fs.writeFile(
        path.join(root, "PLUGIN.md"),
        "---\nname: probe\ndescription: Probe\nentry: ./entry.js\n---\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(directory, "external.js"),
        'throw new Error("external entry executed");',
        "utf8",
      );
      await fs.symlink(
        path.join(directory, "external.js"),
        path.join(root, "entry.js"),
      );
      const discovery = {
        id: "probe",
        rootPath: root,
        isMultiRuntime: false,
        pluginMdPaths: [path.join(root, "PLUGIN.md")],
      };
      await expect(
        loadEntryTools(discovery, await loadPluginDefinition(discovery)),
      ).rejects.toThrow("entry path escapes plugin root");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["factory", "tool", "service", "success"])(
    "publishes services atomically when activation ends with %s",
    async (outcome) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "covel-harness-services-"),
      );
      const services = new PluginServiceRegistry({
        list: async () => ["probe", "other"],
        ensure: async () => {},
      });
      services.register("other", {
        name: "existing",
        contract: "test/v1",
        input: z.object({}),
        output: z.object({}),
        handler: async () => ({}),
      });
      const client = services.createClient({
        sessionId: "s",
        pluginId: "probe",
        signal: new AbortController().signal,
      });
      try {
        await fs.writeFile(
          path.join(root, "PLUGIN.md"),
          "---\nname: probe\ndescription: Probe\nentry: ./entry.js\n---\n",
          "utf8",
        );
        const registration =
          'covel.registerService({ name: "pending", contract: "test/v1", input: covel.toolkit.z.object({}), output: covel.toolkit.z.object({}), handler: async () => ({}) });';
        const ending =
          outcome === "factory"
            ? 'throw new Error("factory failed");'
            : outcome === "tool"
              ? 'covel.registerTool(covel.toolkit.tool({ name: "memory-search", description: "Invalid", parameters: covel.toolkit.z.object({}), execute: async () => ({}) }));'
              : outcome === "service"
                ? registration
                : "";
        await fs.writeFile(
          path.join(root, "entry.js"),
          `export default covel => { ${registration} ${ending} };`,
          "utf8",
        );
        const discovery = {
          id: "probe",
          rootPath: root,
          isMultiRuntime: false,
          pluginMdPaths: [path.join(root, "PLUGIN.md")],
        };
        const activation = loadEntryTools(
          discovery,
          await loadPluginDefinition(discovery),
          services,
        );
        if (outcome === "success") {
          const entry = await activation;
          expect(entry.tools).toEqual([]);
          expect(
            (await client.discover("test/v1")).map(
              ({ pluginId, name }) => `${pluginId}/${name}`,
            ),
          ).toEqual(["other/existing", "probe/pending"]);
          await entry.close();
        } else
          await expect(activation).rejects.toThrow(
            outcome === "factory"
              ? "factory failed"
              : outcome === "tool"
                ? "reserved"
                : "Duplicate plugin service",
          );
        expect(
          (await client.discover("test/v1")).map(
            ({ pluginId, name }) => `${pluginId}/${name}`,
          ),
        ).toEqual(["other/existing"]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("closes a successful entry, unregisters services immediately, and awaits async cleanup", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "covel-harness-dispose-"),
    );
    const marker = path.join(root, "disposed.txt");
    try {
      await fs.writeFile(
        path.join(root, "PLUGIN.md"),
        "---\nname: probe\ndescription: Probe\nentry: ./entry.js\n---\n",
      );
      await fs.writeFile(
        path.join(root, "entry.js"),
        `export default covel => {
          covel.registerService({ name: "active", contract: "test/v1", input: covel.toolkit.z.object({}), output: covel.toolkit.z.object({}), handler: async () => ({}) });
          covel.onDispose(async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            await (await import("node:fs/promises")).writeFile(${JSON.stringify(marker)}, String(covel.signal.aborted));
          });
        };`,
      );
      const discovery = {
        id: "probe",
        rootPath: root,
        isMultiRuntime: false,
        pluginMdPaths: [path.join(root, "PLUGIN.md")],
      };
      const services = new PluginServiceRegistry({
        list: async () => ["probe"],
        ensure: async () => {},
      });
      const client = services.createClient({
        sessionId: "s",
        pluginId: "probe",
        signal: new AbortController().signal,
      });
      const entry = await loadEntryTools(
        discovery,
        await loadPluginDefinition(discovery),
        services,
      );
      expect(await client.discover("test/v1")).toHaveLength(1);
      const closing = entry.close();
      expect(await client.discover("test/v1")).toEqual([]);
      await closing;
      await entry.close();
      expect(await fs.readFile(marker, "utf8")).toBe("true");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs async cleanup and retains both factory and cleanup errors", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "covel-harness-failed-dispose-"),
    );
    const marker = path.join(root, "disposed.txt");
    try {
      await fs.writeFile(
        path.join(root, "PLUGIN.md"),
        "---\nname: probe\ndescription: Probe\nentry: ./entry.js\n---\n",
      );
      await fs.writeFile(
        path.join(root, "entry.js"),
        `export default covel => {
          covel.onDispose(async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            await (await import("node:fs/promises")).writeFile(${JSON.stringify(marker)}, String(covel.signal.aborted));
            throw new Error("cleanup failed");
          });
          throw new Error("factory failed");
        };`,
      );
      const discovery = {
        id: "probe",
        rootPath: root,
        isMultiRuntime: false,
        pluginMdPaths: [path.join(root, "PLUGIN.md")],
      };
      const failure = await loadEntryTools(
        discovery,
        await loadPluginDefinition(discovery),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        message: "factory failed",
        cause: expect.objectContaining({ message: "factory failed" }),
        errors: [
          expect.objectContaining({ message: "factory failed" }),
          expect.objectContaining({ message: "cleanup failed" }),
        ],
      });
      expect(await fs.readFile(marker, "utf8")).toBe("true");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
