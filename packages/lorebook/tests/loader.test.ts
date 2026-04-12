import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  loadLorebookFromDir,
  loadWorldLorebook,
} from "../src/loader.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORLD_A = path.join(HERE, "fixtures", "world-a");

describe("loadWorldLorebook", () => {
  it("loads every entry from a world's lorebook directory", async () => {
    const entries = await loadWorldLorebook(WORLD_A);
    // fixture has 2 selective + 1 constant across two files, plus an
    // empty file that should contribute zero entries.
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.source).toBe("world");
    }
    const ids = entries.map(e => e.id).sort();
    expect(ids).toEqual(["qingping-sect", "su-wan", "world-overview"]);
  });

  it("returns an empty array for a world without a lorebook directory", async () => {
    const entries = await loadWorldLorebook(
      path.join(HERE, "fixtures", "__nonexistent__"),
    );
    expect(entries).toEqual([]);
  });
});

describe("loadLorebookFromDir — edge cases", () => {
  let tmpRoot: string;

  beforeEachTemp();
  async function mkTmp(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), "covel-lorebook-"));
  }
  function beforeEachTemp(): void {
    // nothing — individual tests manage their own temp dirs to avoid
    // vitest's beforeEach/afterEach pairing while keeping tests isolated.
  }

  it("throws a readable error when the top-level YAML is a list, not an object", async () => {
    tmpRoot = await mkTmp();
    try {
      await writeFile(
        path.join(tmpRoot, "bad.yaml"),
        "- id: x\n  content: y\n  strategy: constant\n",
        "utf8",
      );
      await expect(
        loadLorebookFromDir(tmpRoot, { source: "world" }),
      ).rejects.toThrow(/top-level YAML must be an object/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("throws a schema error when an entry is missing required fields", async () => {
    tmpRoot = await mkTmp();
    try {
      await writeFile(
        path.join(tmpRoot, "bad.yaml"),
        "entries:\n  - id: x\n    # content missing\n    strategy: constant\n",
        "utf8",
      );
      await expect(
        loadLorebookFromDir(tmpRoot, { source: "world" }),
      ).rejects.toThrow(/schema validation failed/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("stamps the configured source and pluginId on loaded entries", async () => {
    tmpRoot = await mkTmp();
    try {
      await mkdir(tmpRoot, { recursive: true });
      await writeFile(
        path.join(tmpRoot, "p.yaml"),
        "entries:\n  - id: a\n    content: body\n    strategy: constant\n",
        "utf8",
      );
      const entries = await loadLorebookFromDir(tmpRoot, {
        source: "plugin",
        pluginId: "example-plugin",
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.source).toBe("plugin");
      expect(entries[0]!.pluginId).toBe("example-plugin");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
