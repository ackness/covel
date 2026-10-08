// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import { discoverAndRegisterPlugins } from "../../src/routes/api/bootstrap/plugin-discovery.js";
import { preparePluginReload } from "../../src/routes/api/bootstrap/plugin-reload.js";

describe("host version range of a package already on disk", () => {
  let dir: string;
  let bundled: string;
  let community: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "covel-host-range-"));
    bundled = path.join(dir, "bundled");
    community = path.join(dir, "community");
    await mkdir(bundled);
    await mkdir(community);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writePlugin(id: string, range?: string): Promise<void> {
    const manifest = path.join(community, id, "PLUGIN.md");
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(
      manifest,
      `---\nid: ${id}\nkind: plugin\ndescription: Host range probe\n${
        range ? `covel: "${range}"\n` : ""
      }---\n`,
    );
  }

  async function discover() {
    const eventBus = createEventBus(createMemoryStore());
    try {
      return await discoverAndRegisterPlugins({
        pluginsDir: bundled,
        pluginsDirs: [bundled, community],
        eventBus,
      });
    } finally {
      await eventBus.close();
    }
  }

  it("quarantines a package whose range excludes the host and loads the others", async () => {
    await writePlugin("too-new", ">=99.0.0");
    await writePlugin("fits", ">=0.0.1");
    await writePlugin("unranged");

    const found = await discover();

    const refused = found.registry.get("too-new");
    expect(refused?.status).toBe("error");
    expect(refused?.error).toContain("Plugin too-new needs Covel >=99.0.0");
    expect(found.discoveryMap.has("too-new")).toBe(false);
    expect(found.manifestCache.has("too-new")).toBe(false);
    expect(found.failedDiscoveryMap.has("too-new")).toBe(true);
    expect(found.registry.get("fits")?.status).toBe("registered");
    expect(found.registry.get("unranged")?.status).toBe("registered");
  });

  it("keeps the package refused on reload until its range fits the host", async () => {
    await writePlugin("too-new", ">=99.0.0");
    const found = await discover();
    const quarantined = found.failedDiscoveryMap.get("too-new")!;

    await expect(preparePluginReload(quarantined, [])).rejects.toThrow(
      "Plugin too-new needs Covel >=99.0.0",
    );

    await writePlugin("too-new", ">=0.0.1");
    const reloaded = await preparePluginReload(quarantined, []);
    expect(reloaded.entry.status).toBe("registered");
  });
});
