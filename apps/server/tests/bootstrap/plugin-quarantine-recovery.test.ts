import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import { ToolRegistry } from "@covel/tools";
import { createHookPipeline, createPluginRpcRegistry } from "@covel/runtime";
import { discoverAndRegisterPlugins } from "../../src/routes/api/bootstrap/plugin-discovery.js";
import {
  createBootstrapPluginEntries,
  type BootstrapPluginEntries,
} from "../../src/routes/api/bootstrap/plugin-entry.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(development = true) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "covel-quarantine-"));
  cleanups.push(() => fs.rm(parent, { recursive: true, force: true }));
  const bundled = path.join(parent, "bundled");
  const community = path.join(parent, "community");
  const id = `recovery-${crypto.randomUUID()}`;
  const root = path.join(community, id);
  await fs.mkdir(bundled);
  await fs.mkdir(root, { recursive: true });
  const valid = `---\nid: ${id}\nkind: plugin\ndescription: Recovery probe\nentry: ./entry.mjs\ncontributes:\n  tools: [value]\n---\n`;
  const manifest = path.join(root, "PLUGIN.md");
  await fs.writeFile(
    manifest,
    valid.replace(`id: ${id}`, "id: forged-identity"),
  );
  const state = { imports: 0, activations: 0 };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[id] = state;
  cleanups.push(async () => {
    delete globals[id];
  });
  await fs.writeFile(
    path.join(root, "entry.mjs"),
    `
    globalThis[${JSON.stringify(id)}].imports += 1;
    export default function(api) {
      globalThis[${JSON.stringify(id)}].activations += 1;
      api.registerTool(api.toolkit.tool({ name: "value", description: "value", parameters: api.toolkit.z.object({}), execute: async () => 42 }));
    }
  `,
  );
  const store = createMemoryStore();
  const eventBus = createEventBus(store);
  cleanups.push(() => eventBus.close());
  const discovered = await discoverAndRegisterPlugins({
    pluginsDir: bundled,
    pluginsDirs: [bundled, community],
    eventBus,
  });
  const tools = new ToolRegistry();
  let approved = false;
  const onReload = vi.fn(async () => {});
  const prepareDeclarations = vi.fn(async () => {
    expect(discovered.registry.get(id)?.status).toBe("error");
    expect(state.imports).toBe(0);
  });
  const manager: BootstrapPluginEntries = await createBootstrapPluginEntries({
    ...discovered,
    pluginRegistry: discovered.registry,
    store,
    tools,
    hookPipeline: createHookPipeline(),
    rpcRegistry: createPluginRpcRegistry(),
    development,
    onReload,
    prepareDeclarations,
    isCommunityServerCodeApproved: () => approved,
  });
  cleanups.push(() => manager.close());
  return {
    id,
    root,
    manifest,
    valid,
    state,
    tools,
    manager,
    onReload,
    prepareDeclarations,
    ...discovered,
    approve: () => {
      approved = true;
    },
  };
}

describe("startup quarantine recovery", () => {
  it("watches an invalid community package and restores only static declarations before approval", async () => {
    const f = await fixture();
    expect(f.registry.get(f.id)?.status).toBe("error");
    expect(f.discoveryMap.has(f.id)).toBe(false);
    expect(f.manifestCache.has(f.id)).toBe(false);
    expect(f.failedDiscoveryMap.has(f.id)).toBe(true);
    f.manager.watch();
    await fs.writeFile(f.manifest, f.valid);
    await vi.waitFor(
      () => expect(f.registry.get(f.id)?.status).toBe("registered"),
      { timeout: 3000 },
    );
    expect(f.failedDiscoveryMap.has(f.id)).toBe(false);
    expect(f.manager.hasPendingEntry(f.id)).toBe(true);
    expect(f.state).toEqual({ imports: 0, activations: 0 });
    expect(f.tools.find("value", f.id)).toBeUndefined();
    expect(f.onReload).toHaveBeenCalledWith(f.id);
    expect(f.prepareDeclarations).toHaveBeenCalledTimes(1);
    await expect(f.manager.ensurePluginEntry(f.id, "session")).rejects.toThrow(
      "requires explicit approval",
    );
    f.approve();
    await f.manager.ensurePluginEntry(f.id, "session");
    expect(f.state).toEqual({ imports: 1, activations: 1 });
    expect(f.tools.find("value", f.id)).toBeDefined();
  });

  it("keeps a still-invalid package quarantined and retries an explicit static repair", async () => {
    const f = await fixture();
    await expect(f.manager.reload(f.id)).rejects.toThrow();
    expect(f.discoveryMap.has(f.id)).toBe(false);
    expect(f.failedDiscoveryMap.has(f.id)).toBe(true);
    expect(f.state.imports).toBe(0);
    await fs.writeFile(f.manifest, f.valid);
    await f.manager.reload(f.id);
    expect(f.registry.get(f.id)?.status).toBe("registered");
    expect(f.state.imports).toBe(0);
    await expect(f.manager.reload(f.id)).rejects.toThrow(
      "requires a live server-code approval",
    );
  });

  it("runs a repaired package only when the selected session is approved", async () => {
    const f = await fixture();
    await fs.writeFile(f.manifest, f.valid);
    f.approve();
    await f.manager.reload(f.id, "session");
    expect(f.state).toEqual({ imports: 1, activations: 1 });
    expect(f.tools.find("value", f.id)).toBeDefined();
  });

  it("keeps production quarantine and tolerates a vanished watch root", async () => {
    const production = await fixture(false);
    await fs.writeFile(production.manifest, production.valid);
    await expect(production.manager.reload(production.id)).rejects.toThrow(
      "only in development",
    );
    expect(production.discoveryMap.has(production.id)).toBe(false);
    const vanished = await fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.rm(vanished.root, { recursive: true });
    expect(() => vanished.manager.watch()).not.toThrow();
  });
});
