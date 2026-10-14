// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import { buildPluginSummary } from "../../src/lib/plugin-descriptor.js";
import {
  discoverAndRegisterPlugins,
  publicPluginError,
} from "../../src/routes/api/bootstrap/plugin-discovery.js";

describe("plugin load errors shown to the public", () => {
  let dir: string;
  let bundled: string;
  let community: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "covel-error-paths-"));
    bundled = path.join(dir, "bundled");
    community = path.join(dir, "community");
    await mkdir(bundled);
    await mkdir(community);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces the plugin directory prefix in the error message", () => {
    expect(
      publicPluginError(
        "/srv/covel/plugins/broken/PLUGIN.md: bad field",
        "/srv/covel/plugins/broken",
      ),
    ).toBe("<plugin>/PLUGIN.md: bad field");
  });

  it("keeps the absolute path out of the public summary of a package that fails to load", async () => {
    const pluginDir = path.join(community, "broken");
    await mkdir(pluginDir);
    await writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      "---\nid: broken\nkind: plugin\ndescription: [unclosed\n---\n",
    );

    const eventBus = createEventBus(createMemoryStore());
    try {
      const found = await discoverAndRegisterPlugins({
        pluginsDir: bundled,
        pluginsDirs: [bundled, community],
        eventBus,
      });
      const entry = found.registry.get("broken");
      expect(entry?.status).toBe("error");
      expect(entry?.error).toBeTruthy();
      expect(entry?.error).toContain("<plugin>");
      expect(entry?.error).not.toContain(dir);

      const summary = buildPluginSummary(entry!);
      expect(JSON.stringify(summary)).not.toContain(dir);
    } finally {
      await eventBus.close();
    }
  });
});
