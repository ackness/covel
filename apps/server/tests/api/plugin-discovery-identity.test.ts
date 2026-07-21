/**
 * a plugin whose frontmatter name root diverges from
 * its directory name must NOT register any runtime — the split identity would
 * let a directory impersonate another plugin's (including a builtin's) store
 * namespace and trust tier. Discovery hard-fails the plugin and registers it
 * as `status: "error"` so the frontend can display the problem without
 * aborting boot.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
import { discoverAndRegisterPlugins } from "../../src/routes/api/bootstrap/plugin-discovery.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-discovery-identity-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writePlugin(dirName: string, manifestName: string) {
  const dir = path.join(root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "PLUGIN.md"),
    [
      "---",
      `name: ${manifestName}`,
      "pluginType: plugin",
      "description: identity test fixture",
      "trigger:",
      "  type: manual",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: dirName, version: "0.0.1", type: "module" }),
  );
}

/**
 * A multi-runtime plugin whose two runtimes declare the SAME dataSchemas
 * namespace with different `schemaVersion`. Identity validation passes (both
 * frontmatter roots match the directory), but `registry.register` throws while
 * merging the conflicting schemas — the failure path that must still leave no
 * capability caches behind.
 */
async function writeConflictingSchemaPlugin(dirName: string) {
  const base = path.join(root, dirName);
  const runtimes = [
    { rt: "a", version: 1 },
    { rt: "b", version: 2 },
  ];
  for (const { rt, version } of runtimes) {
    const dir = path.join(base, "runtimes", rt);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "PLUGIN.md"),
      [
        "---",
        `name: ${dirName}/${rt}`,
        "pluginType: plugin",
        "description: conflicting schema fixture",
        "trigger:",
        "  type: manual",
        "dataSchemas:",
        "  shared:",
        `    schemaVersion: ${version}`,
        "    acceptsWorldData: true",
        "    schema: ./schemas/shared.schema.json",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
  }
  await writeFile(
    path.join(base, "package.json"),
    JSON.stringify({ name: dirName, version: "0.0.1", type: "module" }),
  );
}

describe("plugin discovery identity gate ", () => {
  it("registers a matching plugin normally", async () => {
    await writePlugin("honest", "honest");
    const { registry } = await discoverAndRegisterPlugins({
      pluginsDir: root,
      eventBus: createEventBus(createMemoryStore()),
    });
    expect(registry.get("honest")?.status).toBe("registered");
  });

  it("hard-fails a dir/frontmatter mismatch — no runtimes registered", async () => {
    // Directory claims "innocent" but the frontmatter would register as the
    // builtin "narrator" — the loader keys store/proposals/trust on the
    // frontmatter-derived pluginId.
    await writePlugin("innocent", "narrator");
    const { registry } = await discoverAndRegisterPlugins({
      pluginsDir: root,
      eventBus: createEventBus(createMemoryStore()),
    });

    const entry = registry.get("innocent");
    expect(entry?.status).toBe("error");
    expect(entry?.error).toMatch(/identity mismatch/i);
    expect(entry?.loadedRuntimes.size).toBe(0);
    expect(entry?.manifests ?? []).toHaveLength(0);
    // Nothing registered under the impersonated id either.
    expect(registry.get("narrator")).toBeUndefined();
  });

  it("leaves no discovery capability behind for a rejected plugin", async () => {
    // Quarantine, not just registry status: bootstrap wires tools, hooks,
    // wires and RPC actions off discoveryMap/manifestCache, so a plugin that
    // failed validation must be absent from both.
    await writePlugin("innocent", "narrator");
    await writePlugin("honest", "honest");
    const { discoveryMap, manifestCache } = await discoverAndRegisterPlugins({
      pluginsDir: root,
      eventBus: createEventBus(createMemoryStore()),
    });

    expect(discoveryMap.has("innocent")).toBe(false);
    expect(manifestCache.has("innocent")).toBe(false);
    expect(discoveryMap.has("honest")).toBe(true);
    expect(manifestCache.has("honest")).toBe(true);
  });

  it("leaves no discovery capability behind when registry.register throws", async () => {
    // The caches are published just before register(); register() itself can
    // throw (here: a dataSchemas namespace conflict) after they were set, so
    // the failure path must undo them or the plugin stays visible to wiring.
    await writeConflictingSchemaPlugin("conflicted");
    const { registry, discoveryMap, manifestCache } =
      await discoverAndRegisterPlugins({
        pluginsDir: root,
        eventBus: createEventBus(createMemoryStore()),
      });

    expect(registry.get("conflicted")?.status).toBe("error");
    expect(discoveryMap.has("conflicted")).toBe(false);
    expect(manifestCache.has("conflicted")).toBe(false);
  });
});
