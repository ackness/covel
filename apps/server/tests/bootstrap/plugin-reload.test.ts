import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryStore } from "@covel/store/memory";
import { ToolRegistry } from "@covel/tools";
import {
  createPluginRegistry,
  loadPluginDefinition,
  loadPluginSummary,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";
import {
  createHookPipeline,
  createPluginRpcRegistry,
  PluginServiceRegistry,
  PluginExtensionHost,
} from "@covel/runtime";
import { getSpeechWire } from "@covel/ai-provider";
import {
  createBootstrapPluginEntries,
  type BootstrapPluginEntries,
} from "../../src/routes/api/bootstrap/plugin-entry.js";
import { createRuntimeLoader } from "../../src/routes/api/bootstrap/runtime-loader.js";
import type { RpcApprovalGate } from "@covel/approval";
import { buildPluginSummary } from "../../src/lib/plugin-descriptor.js";
const roots: string[] = [];
const managers: BootstrapPluginEntries[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture(withRuntime = false, activateEntry = true) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "covel-reload-"));
  roots.push(parent);
  const id = `reload-${crypto.randomUUID()}`;
  const root = path.join(parent, id);
  await fs.mkdir(root);
  const disposed: number[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[id] = { disposed };
  const source = (
    version: number,
    fail = false,
  ) => `export default function(api) {
    const version = ${version};
    api.onDispose(() => globalThis[${JSON.stringify(id)}].disposed.push(version));
    api.registerTool(api.toolkit.tool({name: 'value', description: 'value', parameters: api.toolkit.z.object({}), execute: async () => version}));
    api.registerService({name: 'value', contract: 'fixture.value@1', input: api.toolkit.z.unknown(), output: api.toolkit.z.number(), handler: async () => version});
    api.registerRpc('value', async () => version);
    api.on('TurnStart', async () => ({action: 'continue', replace: {version}}));
    api.registerWires({speech: [{id: 'voice', synthesize: async () => version}]});
    ${fail ? "throw new Error('fixture initialization failure');" : ""}
  }`;
  const manifest = `---\nid: ${id}\nkind: plugin\ndescription: Fixture\nentry: ./entry.mjs\ncontributes:\n  tools: [value]\n  actions: [value]\n  services: [fixture.value@1]\n  hooks:\n    - event: TurnStart\n  wires: [voice]\n${withRuntime ? "runtime:\n  type: function\n  schedule:\n    trigger:\n      type: manual\n  function:\n    handler: ./handler.mjs\n  guard: ./guard.mjs\n" : ""}---\nFixture\n`;
  await fs.writeFile(path.join(root, "PLUGIN.md"), manifest);
  await fs.writeFile(path.join(root, "entry.mjs"), source(1));
  if (withRuntime) {
    await fs.writeFile(
      path.join(root, "handler.mjs"),
      "export default async function() {return 1}",
    );
    await fs.writeFile(
      path.join(root, "guard.mjs"),
      "export default function() {return 1}",
    );
  }
  const discovery: PluginDiscoveryResult = {
    id,
    rootPath: root,
    isMultiRuntime: false,
    pluginMdPaths: [path.join(root, "PLUGIN.md")],
    source: "community",
  };
  const definition = await loadPluginDefinition(discovery);
  const registry = createPluginRegistry();
  registry.register({
    id,
    rootPath: root,
    source: "community",
    packageManifest: definition.packageManifest,
    manifests: definition.manifests,
    summary: await loadPluginSummary(discovery, undefined, definition),
    loadedRuntimes: new Map(),
    status: "registered",
  });
  let approved = true;
  const tools = new ToolRegistry();
  const hooks = createHookPipeline();
  const rpc = createPluginRpcRegistry();
  const services = new PluginServiceRegistry({
    list: async () => (approved ? [id] : []),
    ensure: async () => {
      if (!approved) throw new Error("revoked");
    },
  });
  const extensions = new PluginExtensionHost(services, []);
  const store = createMemoryStore();
  await store.createSession({
    id: "session",
    locale: "en",
    status: "active",
    phase: "playing",
    activePlugins: [id],
    metadata: {
      approvalScopeNonce: "fixture-scope",
      pluginSelection: { requested: [id], excluded: [] },
    },
    setupRuntimes: {},
    completedPlayerTurns: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const discoveryMap = new Map([[id, discovery]]);
  const manifestCache = new Map([[id, definition.manifests]]);
  await registry.applyPersistedActivations("session", [id], async () => {});
  const runtimeLoader = withRuntime
    ? createRuntimeLoader({
        pluginRegistry: registry,
        discoveryMap,
        manifestCache,
        store,
        getApprovalGate: () =>
          ({ hasGrant: () => approved }) as unknown as RpcApprovalGate,
      })
    : undefined;
  const manager = await createBootstrapPluginEntries({
    discoveryMap,
    manifestCache,
    pluginRegistry: registry,
    store,
    runtimeLoader,
    tools,
    hookPipeline: hooks,
    rpcRegistry: rpc,
    services,
    extensions,
    development: true,
    isCommunityServerCodeApproved: () => approved,
    isCommunityHookApproved: () => approved,
  });
  runtimeLoader?.bindPluginEntry(manager.ensurePluginEntry);
  managers.push(manager);
  if (activateEntry) await manager.ensurePluginEntry(id, "session");
  const client = () =>
    services.createClient({
      sessionId: "session",
      pluginId: id,
      signal: new AbortController().signal,
    });
  return {
    id,
    root,
    source,
    manager,
    runtimeLoader,
    registry,
    globals,
    tools,
    hooks,
    rpc,
    services,
    client,
    disposed,
    store,
    revoke: () => {
      approved = false;
    },
  };
}
describe("plugin generation reload", () => {
  it("reports trusted declaration error metadata and clears it after a successful publication", async () => {
    const f = await fixture(false, false);
    await fs.writeFile(
      path.join(f.root, "entry.mjs"),
      "export default function() {}\n",
    );
    await expect(f.manager.ensurePluginEntry(f.id, "session")).rejects.toThrow(
      "failed to activate",
    );
    expect(
      buildPluginSummary(f.registry.get(f.id)!, f.manager.isEntryPublished),
    ).toMatchObject({
      hostState: "error",
      registrationError: {
        code: "plugin_registration_invalid",
        registration: "declarations",
      },
    });
    await fs.writeFile(path.join(f.root, "entry.mjs"), f.source(2));
    await f.manager.reload(f.id, "session");
    expect(
      buildPluginSummary(f.registry.get(f.id)!, f.manager.isEntryPublished)
        .hostState,
    ).toBe("loaded");
    expect(f.registry.get(f.id)).not.toHaveProperty("registrationError");
  });
  it("projects actual entry publication independently of runtime caches and live approval", async () => {
    const f = await fixture(false, false);
    const summary = () =>
      buildPluginSummary(f.registry.get(f.id)!, f.manager.isEntryPublished);
    expect(summary().hostState).toBe("installed");
    await f.manager.ensurePluginEntry(f.id, "session");
    expect(f.registry.get(f.id)!.loadedRuntimes.size).toBe(0);
    expect(summary().hostState).toBe("loaded");
    await fs.writeFile(path.join(f.root, "entry.mjs"), f.source(2, true));
    await expect(f.manager.reload(f.id, "session")).rejects.toThrow(
      "failed to activate",
    );
    expect(summary()).toMatchObject({
      hostState: "loaded",
      error: expect.any(String),
    });
    f.revoke();
    expect(summary().hostState).toBe("loaded");
    await f.manager.close();
    expect(f.manager.isEntryPublished(f.id)).toBe(false);
  });
  it("coordinates first activation with an in-flight reload without leaking a scope", async () => {
    const f = await fixture(true, false);
    const preparing = Promise.withResolvers<void>();
    const publish = Promise.withResolvers<void>();
    const prepareGeneration = f.runtimeLoader!.prepareGeneration.bind(
      f.runtimeLoader,
    );
    vi.spyOn(f.runtimeLoader!, "prepareGeneration").mockImplementation(
      async (args) => {
        preparing.resolve();
        await publish.promise;
        return prepareGeneration(args);
      },
    );
    await fs.writeFile(path.join(f.root, "entry.mjs"), f.source(2));
    const reloading = f.manager.reload(f.id, "session");
    await preparing.promise;
    const activating = f.manager.ensurePluginEntry(f.id, "session");
    // Let admission resume from its approval check while publication is held.
    await Promise.resolve();
    publish.resolve();
    await Promise.all([reloading, activating]);
    expect(
      await f.client().call({
        pluginId: f.id,
        name: "value",
        contract: "fixture.value@1",
        input: null,
      }),
    ).toBe(2);
    expect(f.disposed).toEqual([]);
    await f.manager.close();
    expect(f.disposed).toEqual([2]);
  });

  it("admits the first entry while capturing runtimes without waiting on its own publication", async () => {
    const f = await fixture(true, false);
    const capturing = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const capture = f.runtimeLoader!.capture.bind(f.runtimeLoader);
    vi.spyOn(f.runtimeLoader!, "capture").mockImplementation(
      async (sessionId) => {
        capturing.resolve();
        await proceed.promise;
        return capture(sessionId);
      },
    );
    expect(f.manager.hasPendingEntry(f.id)).toBe(true);
    const snapshot = f.manager.withSnapshot("session", async () => {
      expect(f.manager.hasPendingEntry(f.id)).toBe(false);
      const manifest = f.registry.getActiveRuntimes("session")[0]!;
      const runtime = await f.runtimeLoader!.loadRuntimeFn(
        manifest,
        "en",
        "session",
      );
      expect(await runtime!.handler!({} as never)).toBe(1);
      expect(
        await f.client().call({
          pluginId: f.id,
          name: "value",
          contract: "fixture.value@1",
          input: null,
        }),
      ).toBe(1);
    });
    await capturing.promise;
    const activating = f.manager.ensurePluginEntry(f.id, "session");
    // Capture and explicit activation share one plugin preparation.
    await Promise.resolve();
    proceed.resolve();
    await Promise.all([snapshot, activating]);
    await f.manager.close();
    expect(f.disposed).toEqual([1]);
  });

  it("lets unrelated sessions capture while runtime admission waits for a factory", async () => {
    const f = await fixture(true, false);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.globals[f.id] = { disposed: f.disposed, started, release };
    await fs.writeFile(
      path.join(f.root, "entry.mjs"),
      f.source(1).replace(
        "export default function(api) {",
        `export default async function(api) {
        globalThis[${JSON.stringify(f.id)}].started.resolve();
        await globalThis[${JSON.stringify(f.id)}].release.promise;`,
      ),
    );
    const session = (await f.store.getSession("session"))!;
    await f.store.createSession({
      ...session,
      id: "other",
      activePlugins: [],
      metadata: {},
    });
    const snapshot = f.manager.withSnapshot("session", async () => "ready");
    try {
      await started.promise;
      await expect(
        f.manager.withSnapshot("other", async () => "independent"),
      ).resolves.toBe("independent");
      expect(f.manager.isEntryPublished(f.id)).toBe(false);
    } finally {
      release.resolve();
      await snapshot;
    }
  });

  it("does not retry failed entry admission while capturing runtimes", async () => {
    const f = await fixture(true, false);
    await fs.writeFile(path.join(f.root, "entry.mjs"), f.source(1, true));
    const capture = vi.spyOn(f.runtimeLoader!, "capture");
    await expect(
      f.manager.withSnapshot("session", async () => {}),
    ).rejects.toThrow("failed to activate");
    expect(capture).toHaveBeenCalledOnce();
    expect(f.disposed).toEqual([1]);
    expect(f.manager.isEntryRetryDeferred(f.id)).toBe(true);
  });

  it("keeps the current generation capturable while reload prepares runtime modules", async () => {
    const f = await fixture(true);
    const preparing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const prepare = f.runtimeLoader!.prepareGeneration.bind(f.runtimeLoader);
    vi.spyOn(f.runtimeLoader!, "prepareGeneration").mockImplementation(
      async (args) => {
        preparing.resolve();
        await release.promise;
        return prepare(args);
      },
    );
    await fs.writeFile(path.join(f.root, "entry.mjs"), f.source(2));
    const reloading = f.manager.reload(f.id, "session");
    try {
      await preparing.promise;
      await f.manager.withSnapshot("session", async () => {
        expect(
          await f.client().call({
            pluginId: f.id,
            name: "value",
            contract: "fixture.value@1",
            input: null,
          }),
        ).toBe(1);
      });
    } finally {
      release.resolve();
      await reloading;
    }
  });

  it.each([false, true])(
    "recaptures a concurrently replaced runtime generation, interruptedLoad=%s",
    async (interruptedLoad) => {
      const f = await fixture(true);
      const loaded = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const capture = f.runtimeLoader!.capture.bind(f.runtimeLoader);
      const capturing = vi
        .spyOn(f.runtimeLoader!, "capture")
        .mockImplementationOnce(async (sessionId) => {
          const artifacts = await capture(sessionId);
          loaded.resolve();
          await release.promise;
          if (interruptedLoad)
            throw new Error("manifest changed during loading");
          return artifacts;
        });
      const snapshot = f.manager.withSnapshot("session", async () => {
        const manifest = f.registry.getActiveRuntimes("session")[0]!;
        const runtime = await f.runtimeLoader!.loadRuntimeFn(
          manifest,
          "en",
          "session",
        );
        expect(await runtime!.handler!({} as never)).toBe(2);
        expect(
          await f.client().call({
            pluginId: f.id,
            name: "value",
            contract: "fixture.value@1",
            input: null,
          }),
        ).toBe(2);
      });
      try {
        await loaded.promise;
        await fs.writeFile(path.join(f.root, "entry.mjs"), f.source(2));
        await fs.writeFile(
          path.join(f.root, "handler.mjs"),
          "export default async function() {return 2}",
        );
        await f.manager.reload(f.id, "session");
      } finally {
        release.resolve();
        await snapshot;
      }
      expect(capturing).toHaveBeenCalledTimes(2);
    },
  );

  it("rechecks approval before a queued first activation can invoke its factory", async () => {
    const f = await fixture(true, false);
    const capturing = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const snapshot = f.manager.withSnapshot(
      "session",
      async () => {},
      async () => {
        capturing.resolve();
        await proceed.promise;
      },
    );
    await capturing.promise;
    const activation = f.manager.ensurePluginEntry(f.id, "session");
    const rejected = expect(activation).rejects.toThrow("approval was revoked");
    await Promise.resolve();
    f.revoke();
    proceed.resolve();
    await Promise.all([snapshot, rejected]);
    expect(f.manager.hasPendingEntry(f.id)).toBe(true);
    expect(f.tools.find("value", f.id)).toBeUndefined();
    await f.manager.close();
    expect(f.disposed).toEqual([]);
  });

  it("recomputes dependencies before admitting a reloaded generation and preserves the running snapshot", async () => {
    const f = await fixture(true);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const old = f.manager.withSnapshot("session", async () => {
      started.resolve();
      await finish.promise;
      expect(
        f.registry.getActiveRuntimes("session").map((r) => r.pluginId),
      ).toEqual([f.id]);
    });
    await started.promise;
    const file = path.join(f.root, "PLUGIN.md");
    const original = await fs.readFile(file, "utf8");
    await fs.writeFile(
      file,
      original.replace(
        "kind: plugin",
        "kind: plugin\nrequires: [missing-provider@1]",
      ),
    );
    await f.manager.reload(f.id, "session");
    await f.manager.withSnapshot("session", async () => {
      expect(f.registry.getActiveRuntimes("session")).toEqual([]);
      expect((await f.store.getSession("session"))?.activePlugins).toEqual([]);
    });
    finish.resolve();
    await old;
    // Keep the user's requested selection, so fixing the declaration restores it.
    await fs.writeFile(file, original);
    await f.manager.reload(f.id, "session");
    await f.manager.withSnapshot("session", async () => {
      expect(
        f.registry.getActiveRuntimes("session").map((r) => r.pluginId),
      ).toEqual([f.id]);
    });
  });
  it("atomically publishes the new generation while captured executions retain old lookups and resources", async () => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const old = f.manager.withSnapshot("session", async () => {
      started.resolve();
      await finish.promise;
      expect(
        await f.client().call({
          pluginId: f.id,
          name: "value",
          contract: "fixture.value@1",
          input: null,
        }),
      ).toBe(1);
      expect(await f.tools.find("value", f.id)!.execute({}, {} as never)).toBe(
        1,
      );
      expect(
        await f.rpc
          .getPluginAction(f.id, "value")!
          .handler({} as never, {} as never),
      ).toBe(1);
      expect(
        await f.hooks.run(
          "TurnStart",
          { event: "TurnStart", sessionId: "session", turnId: "turn" },
          {},
        ),
      ).toMatchObject({ replace: { version: 1 } });
      expect(
        await getSpeechWire(`${f.id}/voice`)!.synthesize({} as never),
      ).toBe(1);
      expect(f.disposed).toEqual([]);
    });
    await started.promise;
    await fs.writeFile(path.join(f.root, "entry.mjs"), f.source(2));
    await f.manager.reload(f.id, "session");
    expect(
      await f.client().call({
        pluginId: f.id,
        name: "value",
        contract: "fixture.value@1",
        input: null,
      }),
    ).toBe(2);
    expect(f.disposed).toEqual([]);
    finish.resolve();
    await old;
    await Promise.resolve();
    await Promise.resolve();
    expect(f.disposed).toEqual([1]);
  });
  it("rolls back a failed factory and refuses reload after live approval is revoked", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "entry.mjs"), f.source(2, true));
    await expect(f.manager.reload(f.id, "session")).rejects.toThrow(
      "failed to activate",
    );
    expect(
      await f.client().call({
        pluginId: f.id,
        name: "value",
        contract: "fixture.value@1",
        input: null,
      }),
    ).toBe(1);
    expect(f.disposed).toEqual([2]);
    f.revoke();
    await expect(f.manager.reload(f.id, "session")).rejects.toThrow("approval");
  });
  it("captures handler and guard modules, validates new artifacts before publication, and keeps grants live", async () => {
    const f = await fixture(true);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const read = async () => {
      const manifest = f.registry.getActiveRuntimes("session")[0]!;
      return (await f.runtimeLoader!.loadRuntimeFn(manifest, "en", "session"))!;
    };
    const old = f.manager.withSnapshot("session", async () => {
      started.resolve();
      await finish.promise;
      const artifact = await read();
      expect(await artifact.handler!({} as never)).toBe(1);
      expect(await artifact.guard!({} as never)).toBe(1);
    });
    await started.promise;
    await fs.writeFile(
      path.join(f.root, "handler.mjs"),
      "export default async function() {return 2}",
    );
    await fs.writeFile(
      path.join(f.root, "guard.mjs"),
      "export default function() {return 2}",
    );
    await fs.writeFile(path.join(f.root, "entry.mjs"), f.source(2));
    await f.manager.reload(f.id, "session");
    await f.manager.withSnapshot("session", async () => {
      const artifact = await read();
      expect(await artifact.handler!({} as never)).toBe(2);
      expect(await artifact.guard!({} as never)).toBe(2);
    });
    finish.resolve();
    await old;
    await fs.writeFile(path.join(f.root, "handler.mjs"), "export default 3");
    await expect(f.manager.reload(f.id, "session")).rejects.toThrow(
      "default function",
    );
    await f.manager.withSnapshot("session", async () => {
      expect(await (await read()).handler!({} as never)).toBe(2);
      f.revoke();
      await expect(read()).rejects.toThrow("approval");
      await expect(
        f.client().call({
          pluginId: f.id,
          name: "value",
          contract: "fixture.value@1",
          input: null,
        }),
      ).rejects.toThrow("revoked");
    });
  });

  it("restores every registry after a staged publication fails", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.root, "entry.mjs"),
      f.source(2).replace("input: api.toolkit.z.unknown()", "input: null"),
    );
    await expect(f.manager.reload(f.id, "session")).rejects.toThrow(
      "registerService",
    );
    expect(
      await f.client().call({
        pluginId: f.id,
        name: "value",
        contract: "fixture.value@1",
        input: null,
      }),
    ).toBe(1);
    expect(await f.tools.find("value", f.id)!.execute({}, {} as never)).toBe(1);
    expect(
      await f.rpc
        .getPluginAction(f.id, "value")!
        .handler({} as never, {} as never),
    ).toBe(1);
    expect(await getSpeechWire(`${f.id}/voice`)!.synthesize({} as never)).toBe(
      1,
    );
    expect(f.disposed).toEqual([2]);
  });

  it("reloads approved community files through the development watcher", async () => {
    const f = await fixture();
    f.manager.watch();
    await fs.writeFile(path.join(f.root, "entry.mjs"), f.source(2));
    await vi.waitFor(async () => {
      expect(
        await f.client().call({
          pluginId: f.id,
          name: "value",
          contract: "fixture.value@1",
          input: null,
        }),
      ).toBe(2);
    });
    expect(f.disposed).toEqual([1]);
  });

  it("retains a timed-out provider until its losing promise finishes", async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    const state = f.globals[f.id] as {
      disposed: number[];
      gate?: Promise<void>;
    };
    state.gate = gate.promise;
    await fs.writeFile(
      path.join(f.root, "entry.mjs"),
      f
        .source(2)
        .replace(
          "handler: async () => version",
          `handler: async () => {await globalThis[${JSON.stringify(f.id)}].gate; return version}`,
        ),
    );
    await f.manager.reload(f.id, "session");
    await f.manager.withSnapshot("session", async () => {
      await expect(
        f.client().call(
          {
            pluginId: f.id,
            name: "value",
            contract: "fixture.value@1",
            input: null,
          },
          { timeoutMs: 5 },
        ),
      ).rejects.toThrow("timed out");
    });
    await fs.writeFile(path.join(f.root, "entry.mjs"), f.source(3));
    await f.manager.reload(f.id, "session");
    expect(f.disposed).toEqual([1]);
    gate.resolve();
    await vi.waitFor(() => expect(f.disposed).toEqual([1, 2]));
  });
});
