import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { loadPluginDefinition } from "@covel/plugin-loader";
import {
  PluginServiceRegistry,
  PluginExtensionHost,
  kernelExtensionPoints,
} from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
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

  it("admits services only for selected packages active in the same session", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: "selected-session",
      locale: "zh-CN",
      status: "active",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: ["lifecycle-probe"],
      createdAt: now,
      updatedAt: now,
    });
    const bundle = await loadRuntimeBundle({
      pluginsDir: path.resolve(
        import.meta.dirname,
        "../../../tests/third-party",
      ),
      pluginId: "lifecycle-probe",
      runtimeId: "lifecycle-probe/note",
      locale: "zh-CN",
      withPlugins: ["service-provider-probe"],
      store,
    });
    try {
      const client = bundle.services.createClient({
        sessionId: "selected-session",
        pluginId: "lifecycle-probe",
        signal: new AbortController().signal,
      });
      expect(await client.discover("probe.note-format@1")).toEqual([]);
      await expect(
        client.call({
          pluginId: "service-provider-probe",
          name: "format-note",
          contract: "probe.note-format@1",
          input: { text: "hello" },
        }),
      ).rejects.toThrow('plugin "service-provider-probe" is not active');
      await store.updateSession("selected-session", {
        activePlugins: ["lifecycle-probe", "service-provider-probe"],
      });
      expect(await client.discover("probe.note-format@1")).toMatchObject([
        { pluginId: "service-provider-probe", name: "format-note" },
      ]);
      await store.updateSession("selected-session", {
        activePlugins: ["service-provider-probe"],
      });
      await expect(client.discover("probe.note-format@1")).rejects.toThrow(
        'plugin "lifecycle-probe" is not active',
      );
      const otherSession = bundle.services.createClient({
        sessionId: "missing-session",
        pluginId: "lifecycle-probe",
        signal: new AbortController().signal,
      });
      await expect(
        otherSession.discover("probe.note-format@1"),
      ).rejects.toThrow('session "missing-session" not found');
    } finally {
      await bundle.close();
      await store.close();
    }
  });

  it.each([false, true])(
    "publishes static prompts and validates extensions without an entry, missing=%s",
    async (missing) => {
      const rootPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "covel-static-entry-"),
      );
      const services = new PluginServiceRegistry({
        list: async () => ["probe"],
        ensure: async () => {},
      });
      const extensions = new PluginExtensionHost(services);
      try {
        await fs.writeFile(
          path.join(rootPath, "PLUGIN.md"),
          `---\nid: probe\nkind: plugin\ndescription: Static\ncontributes:\n  prompt: [{id: note, content: Static, position: pre-history}]\n${missing ? "  extensions: [{point: 'prompt.history-transform@1', id: missing}]\n" : ""}---\n`,
        );
        const discovery = {
          id: "probe",
          rootPath,
          isMultiRuntime: false,
          pluginMdPaths: [],
        };
        const loading = loadEntryTools(
          discovery,
          await loadPluginDefinition(discovery),
          services,
          extensions,
        );
        if (missing) {
          await expect(loading).rejects.toThrow(/extension/i);
          expect(extensions.list()).toEqual([]);
        } else {
          const entry = await loading;
          try {
            expect(entry.tools).toEqual([]);
            expect(extensions.list()).toHaveLength(1);
          } finally {
            await entry.close();
          }
          expect(extensions.list()).toEqual([]);
        }
      } finally {
        await fs.rm(rootPath, { recursive: true, force: true });
      }
    },
  );
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
          "id: plugin",
          "kind: plugin",
          "description: Test plugin",
          "contributes: {tools: [root-tool], forms: [check]}",
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
        pluginMdPaths: [path.join(rootPath, "runtimes/main/RUNTIME.md")],
      };
      await fs.mkdir(path.join(rootPath, "runtimes/main"), { recursive: true });
      await fs.writeFile(
        discovery.pluginMdPaths[0]!,
        "---\ndescription: Main\nschedule: {trigger: {type: manual}}\n---\n",
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
  it("shares package declarations with each child runtime", async () => {
    const pluginsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "covel-harness-package-"),
    );
    const root = path.join(pluginsDir, "probe");
    try {
      await fs.mkdir(path.join(root, "runtimes/main"), { recursive: true });
      await fs.writeFile(
        path.join(root, "PLUGIN.md"),
        `---
id: probe
kind: plugin
description: Package
contributes:
  settings:
    - key: mode
      type: text
      label: Mode
      default: brief
  data:
    notes:
      schema: ./schemas/notes.json
      version: 1
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
        path.join(root, "runtimes/main/RUNTIME.md"),
        `---
description: Main
function: {handler: ./handler.js}
schedule: {trigger: {type: manual}}
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
        runtimeId: "probe/main",
        locale: "zh-CN",
      });
      expect(bundle.target.userSettings?.[0]?.default).toBe("brief");
      expect(bundle.target.dataSchemas?.notes?.schema).toBe(
        "./schemas/notes.json",
      );
      expect(
        bundle.loadedCache.get("probe/main")?.manifest.userSettings,
      ).toEqual(bundle.target.userSettings);
      expect(
        bundle.loadedCache.get("probe/main")?.manifest.dataSchemas,
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
          `---\nid: probe\nkind: plugin\ndescription: Probe\nentry: ./entry.js\ncontributes: {tools: [${name}]}\n---\n`,
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
        "---\nid: probe\nkind: plugin\ndescription: Probe\nentry: ./entry.js\n---\n",
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
        contract: "test.service@1",
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
          `---\nid: probe\nkind: plugin\ndescription: Probe\nentry: ./entry.js\ncontributes: {services: [test.service@1]${outcome === "tool" ? ", tools: [memory-search]" : ""}}\n---\n`,
          "utf8",
        );
        const registration =
          'covel.registerService({ name: "pending", contract: "test.service@1", input: covel.toolkit.z.object({}), output: covel.toolkit.z.object({}), handler: async () => ({}) });';
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
            (await client.discover("test.service@1")).map(
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
                : "duplicate registration",
          );
        expect(
          (await client.discover("test.service@1")).map(
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
        "---\nid: probe\nkind: plugin\ndescription: Probe\nentry: ./entry.js\ncontributes: {services: [test.service@1]}\n---\n",
      );
      await fs.writeFile(
        path.join(root, "entry.js"),
        `export default covel => {
          covel.registerService({ name: "active", contract: "test.service@1", input: covel.toolkit.z.object({}), output: covel.toolkit.z.object({}), handler: async () => ({}) });
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
      expect(await client.discover("test.service@1")).toHaveLength(1);
      const closing = entry.close();
      expect(await client.discover("test.service@1")).toEqual([]);
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
        "---\nid: probe\nkind: plugin\ndescription: Probe\nentry: ./entry.js\n---\n",
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

  it("enforces permissions.http on covel.http and service/extension context.utils", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "covel-harness-http-perms-"),
    );
    const services = new PluginServiceRegistry({
      list: async () => ["probe"],
      ensure: async () => {},
    });
    const extensions = new PluginExtensionHost(services);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      await fs.writeFile(
        path.join(root, "PLUGIN.md"),
        `---
id: probe
kind: plugin
description: Probe HTTP permissions
entry: ./entry.js
permissions:
  http:
    - origin: https://93.184.216.34
      methods: [GET]
contributes:
  services: [probe.fetch@1]
  extensions:
    - point: prompt.segment@1
      id: http-check
---
`,
        "utf8",
      );
      await fs.writeFile(
        path.join(root, "entry.js"),
        `export default async (covel) => {
          let blockedEntry = false;
          try {
            await covel.http.fetchWithRetry("https://blocked.example.test/secret");
          } catch (err) {
            blockedEntry = /http permission denied/.test(String(err));
          }
          let blockedMethod = false;
          try {
            await covel.http.fetchWithRetry("https://93.184.216.34/post", { method: "POST" });
          } catch (err) {
            blockedMethod = /http permission denied/.test(String(err));
          }
          const allowedRes = await covel.http.fetchWithRetry("https://93.184.216.34/ok");
          if (!blockedEntry || !blockedMethod || allowedRes.status !== 200) {
            throw new Error(\`unexpected entry http results: \${blockedEntry},\${blockedMethod},\${allowedRes.status}\`);
          }
          covel.registerService({
            name: "fetch",
            contract: "probe.fetch@1",
            input: covel.toolkit.z.object({ url: covel.toolkit.z.string() }),
            output: covel.toolkit.z.object({ status: covel.toolkit.z.number() }),
            handler: async ({ url }, ctx) => {
              const res = await ctx.utils.fetchWithRetry(url);
              return { status: res.status };
            },
          });
          covel.provideExtension("prompt.segment@1", "http-check", {
            handler: async (_input, ctx) => {
              if (ctx.utils) {
                await ctx.utils.fetchWithRetry("https://blocked.example.test/ext");
              }
              return [];
            },
          });
        };`,
        "utf8",
      );
      const discovery = {
        id: "probe",
        rootPath: root,
        isMultiRuntime: false,
        pluginMdPaths: [path.join(root, "PLUGIN.md")],
      };
      const entry = await loadEntryTools(
        discovery,
        await loadPluginDefinition(discovery),
        services,
        extensions,
      );
      try {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const client = services.createClient({
          sessionId: "s",
          pluginId: "probe",
          signal: new AbortController().signal,
          utils: {
            fetchWithRetry: async () =>
              new Response("raw-bypass", { status: 200 }),
            validateBaseUrl: () => ({ ok: true }),
          },
        });
        await expect(
          client.call({
            pluginId: "probe",
            name: "fetch",
            contract: "probe.fetch@1",
            input: { url: "https://blocked.example.test/service" },
          }),
        ).rejects.toThrow(/http permission denied/);
        await expect(
          client.call({
            pluginId: "probe",
            name: "fetch",
            contract: "probe.fetch@1",
            input: { url: "https://93.184.216.34/service" },
          }),
        ).resolves.toEqual({ status: 200 });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const extErrors: string[] = [];
        const promptSegmentPoint = kernelExtensionPoints.find(
          (point) => point.id === "prompt.segment@1",
        )!;
        const extExecution = extensions.createExecution({
          sessionId: "s",
          locale: "en",
          turnId: "turn-1",
          signal: new AbortController().signal,
          settings: {},
          readPluginData: async () => [],
          utils: {
            fetchWithRetry: async () =>
              new Response("raw-bypass", { status: 200 }),
            validateBaseUrl: () => ({ ok: true }),
          },
          onProviderError: ({ error }) => {
            extErrors.push(
              error instanceof Error ? error.message : String(error),
            );
          },
        });
        await extExecution.run(promptSegmentPoint, {
          turnId: "turn-1",
          playerMessage: "hello",
        });
        expect(extErrors).toEqual([
          expect.stringMatching(/http permission denied/),
        ]);
      } finally {
        await entry.close();
      }
    } finally {
      fetchSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "reserved covel: rpc prefix (swallowed by factory)",
      contributes: "",
      body: 'try { covel.registerRpc("covel:admin", async () => ({})); } catch {}',
      pattern: /reserved/,
    },
    {
      label: "reserved runtime: rpc prefix (swallowed by factory)",
      contributes: "",
      body: 'try { covel.registerRpc("runtime:run", async () => ({})); } catch {}',
      pattern: /reserved/,
    },
    {
      label: "duplicate rpc action (swallowed by factory)",
      contributes: "contributes: {actions: [ping]}",
      body: 'covel.registerRpc("ping", async () => ({})); try { covel.registerRpc("ping", async () => ({})); } catch {}',
      pattern: /already registered/,
    },
    {
      label: "invalid rpc options key",
      contributes: "contributes: {actions: [ping]}",
      body: 'covel.registerRpc("ping", async () => ({}), { extra: true });',
      pattern: /Unrecognized key|extra/i,
    },
    {
      label: "invalid rpc handler",
      contributes: "contributes: {actions: [ping]}",
      body: 'covel.registerRpc("ping", "not-a-fn");',
      pattern: /handler function/,
    },
    {
      label: "invalid form validator",
      contributes: "contributes: {forms: [check]}",
      body: 'covel.registerFormValidator("check", "not-a-fn");',
      pattern: /validator function/,
    },
    {
      label: "duplicate form validator (swallowed by factory)",
      contributes: "contributes: {forms: [check]}",
      body: 'covel.registerFormValidator("check", async () => undefined); try { covel.registerFormValidator("check", async () => undefined); } catch {}',
      pattern: /Duplicate form validator/,
    },
    {
      label: "invalid wire shape (missing generate)",
      contributes: "contributes: {wires: [img]}",
      body: 'covel.registerWires({ image: [{ id: "img" }] });',
      pattern: /generate: function/,
    },
    {
      label: "invalid text wire shape (missing streamText)",
      contributes: "contributes: {wires: [txt]}",
      body: 'covel.registerWires({ text: [{ id: "txt", generateText: async () => ({}) }] });',
      pattern: /streamText: function/,
    },
    {
      label: "duplicate wire id (swallowed by factory)",
      contributes: "contributes: {wires: [img]}",
      body: 'const w = { id: "img", generate: async () => ({}) }; covel.registerWires({ image: [w] }); try { covel.registerWires({ image: [w] }); } catch {}',
      pattern: /already registered/,
    },
  ])(
    "validates entry registrations: rejects $label",
    async ({ contributes, body, pattern }) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "covel-harness-entry-validation-"),
      );
      try {
        await fs.writeFile(
          path.join(root, "PLUGIN.md"),
          `---\nid: probe\nkind: plugin\ndescription: Probe\nentry: ./entry.js\n${contributes}\n---\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(root, "entry.js"),
          `export default (covel) => { ${body} };`,
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
        ).rejects.toThrow(pattern);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
