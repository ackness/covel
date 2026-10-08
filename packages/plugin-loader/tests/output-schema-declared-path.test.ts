import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discoverPlugins } from "../src/discover.js";
import { loadRuntime } from "../src/load.js";

function makeFrontmatter(overrides: Record<string, unknown>): string {
  const merged = {
    id: "test-plugin",
    kind: "plugin",
    description: "A test plugin",
    runtime: { type: "agent", schedule: { stage: "narrative" }, io: overrides },
  };
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
    const pluginDir = path.join(tmpDir, "test-plugin");
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
    const pluginDir = path.join(tmpDir, "test-plugin");
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
    const pluginDir = path.join(tmpDir, "test-plugin");
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

  it("rejects a missing declared schema with its path and field", async () => {
    const pluginDir = path.join(tmpDir, "test-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      makeFrontmatter({ output: { schema: "./schemas/out.schema.json" } }),
    );

    const [discovery] = await discoverPlugins(tmpDir);
    await expect(loadRuntime(discovery, "test-plugin")).rejects.toThrow(
      /schemas.*out.schema.json: io.output.schema: file not found/,
    );
  });
});

describe("loadRuntime binding accepts contracts", () => {
  async function load(
    required: boolean,
    contracts: Record<string, Record<string, unknown>> = {},
  ) {
    const pluginDir = path.join(tmpDir, "test-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      makeFrontmatter({
        inputs: {
          facts: {
            from: { contract: "facts-provider@1" },
            accepts: "contract:facts@1",
            required,
          },
        },
      }).replace(
        "kind: plugin",
        `kind: plugin\n${required ? "requires" : "optional"}: ["facts-provider@1"]`,
      ),
    );
    const [discovery] = await discoverPlugins(tmpDir);
    return loadRuntime(
      discovery,
      "test-plugin",
      undefined,
      undefined,
      contracts,
    );
  }

  it("loads a runtime whose optional binding accepts a contract that is not installed", async () => {
    const loaded = await load(false);
    expect(loaded.bindingAcceptsSchemas).toBeUndefined();
    expect(loaded.unresolvedAccepts).toEqual(["facts"]);
  });

  it("checks the optional binding once the contract is installed", async () => {
    const loaded = await load(false, { "facts@1": SCHEMA });
    expect(loaded.bindingAcceptsSchemas).toEqual({ facts: SCHEMA });
    expect(loaded.unresolvedAccepts).toBeUndefined();
  });

  it("still refuses a required binding whose accepts contract is not installed", async () => {
    await expect(load(true)).rejects.toThrow(
      "Unresolved schema contract: contract:facts@1",
    );
  });
});
