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
});
