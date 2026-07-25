import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discoverPlugins } from "../src/discover.js";
import { loadRuntime } from "../src/load.js";

function makeFrontmatter(overrides: Record<string, unknown>): string {
  const base = {
    name: "test-plugin",
    description: "A test plugin",
    stage: "narrative",
  };
  const merged = { ...base, ...overrides };
  const yaml = Object.entries(merged)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\nYou are a test agent.\n`;
}

const SCHEMA = {
  type: "object",
  properties: { result: { type: "string" } },
};

let tmpDir: string;

beforeEach(async () => {
  // realpath: on macOS os.tmpdir() is a symlink (/var → /private/var); the
  // containment check compares realpath'd roots, so use a resolved base to
  // match how non-symlinked production plugin roots behave.
  tmpDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "covel-out-schema-")),
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadRuntime output schema resolution", () => {
  it("loads schema from the declared output.schema path", async () => {
    const pluginDir = path.join(tmpDir, "declared");
    await fs.mkdir(path.join(pluginDir, "schemas"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      makeFrontmatter({ output: { schema: "./schemas/out.schema.json" } }),
    );
    await fs.writeFile(
      path.join(pluginDir, "schemas", "out.schema.json"),
      JSON.stringify(SCHEMA),
    );
    // A file at the convention path must NOT be preferred over the declaration.
    await fs.writeFile(
      path.join(pluginDir, "output.schema.json"),
      JSON.stringify({ type: "object", properties: { wrong: {} } }),
    );

    const [discovery] = await discoverPlugins(tmpDir);
    const loaded = await loadRuntime(discovery, "test-plugin");

    expect(loaded.outputSchema).toEqual(SCHEMA);
  });

  it("falls back to the output.schema.json convention when undeclared", async () => {
    const pluginDir = path.join(tmpDir, "convention");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), makeFrontmatter({}));
    await fs.writeFile(
      path.join(pluginDir, "output.schema.json"),
      JSON.stringify(SCHEMA),
    );

    const [discovery] = await discoverPlugins(tmpDir);
    const loaded = await loadRuntime(discovery, "test-plugin");

    expect(loaded.outputSchema).toEqual(SCHEMA);
  });

  it("rejects a declared path that escapes the plugin root", async () => {
    const pluginDir = path.join(tmpDir, "escape");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      makeFrontmatter({ output: { schema: "../escape.json" } }),
    );
    // A real file outside the root — containment must reject before reading it.
    await fs.writeFile(
      path.join(tmpDir, "escape.json"),
      JSON.stringify(SCHEMA),
    );

    const [discovery] = await discoverPlugins(tmpDir);

    await expect(loadRuntime(discovery, "test-plugin")).rejects.toThrow(
      /path traversal rejected/,
    );
  });

  it("warns and does not crash when the declared file is missing", async () => {
    const pluginDir = path.join(tmpDir, "missing");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      makeFrontmatter({ output: { schema: "./schemas/out.schema.json" } }),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const [discovery] = await discoverPlugins(tmpDir);
      const loaded = await loadRuntime(discovery, "test-plugin");

      expect(loaded.outputSchema).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "[plugin-loader] declared output schema not found",
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
