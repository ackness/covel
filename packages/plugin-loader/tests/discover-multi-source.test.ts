import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discoverPluginsMulti } from "../src/discover.js";
import { getPluginTrustInfo } from "../src/trust.js";

const FRONTMATTER = `---
name: sample
description: sample
stage: narrative
---

agent.
`;

let bundledDir: string;
let userDir: string;

beforeEach(async () => {
  bundledDir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-bundled-"));
  userDir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-user-"));
});

afterEach(async () => {
  await fs.rm(bundledDir, { recursive: true, force: true });
  await fs.rm(userDir, { recursive: true, force: true });
});

async function writePlugin(dir: string, id: string): Promise<void> {
  const pluginDir = path.join(dir, id);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), FRONTMATTER);
}

describe("discoverPluginsMulti — load-path-based source tagging", () => {
  it("tags every plugin from the first (bundled) directory with source: 'builtin'", async () => {
    // Regression: dropping the `core-` prefix heuristic (commit 85a7684) shifted
    // trust derivation to load-path-based `source` tagging. discoverPluginsMulti
    // must therefore stamp `source: 'builtin'` on results from index 0 — without
    // it, getPluginTrustInfo falls through to the community fallback and
    // bootstrap skips importing tools.local for shipped plugins, breaking
    // codex/guide/npc-graph local tool calls at runtime.
    await writePlugin(bundledDir, "codex");
    await writePlugin(bundledDir, "guide");

    const results = await discoverPluginsMulti([bundledDir]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.source).toBe("builtin");
      expect(getPluginTrustInfo(result.id, result.source).autoLoad).toBe(true);
    }
  });

  it("tags plugins from non-first directories with source: 'community'", async () => {
    await writePlugin(userDir, "third-party");

    const results = await discoverPluginsMulti([bundledDir, userDir]);

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("community");
    expect(getPluginTrustInfo(results[0].id, results[0].source).autoLoad).toBe(
      false,
    );
  });

  it("keeps the bundled copy on id collision and still tags it builtin", async () => {
    await writePlugin(bundledDir, "codex");
    await writePlugin(userDir, "codex"); // attempted shadow

    const collisions: Array<[string, string, string]> = [];
    const results = await discoverPluginsMulti(
      [bundledDir, userDir],
      (id, kept, skipped) => {
        collisions.push([id, kept, skipped]);
      },
    );

    expect(collisions).toEqual([
      ["codex", path.join(bundledDir, "codex"), path.join(userDir, "codex")],
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("builtin");
    expect(results[0].rootPath).toBe(path.join(bundledDir, "codex"));
  });
});
