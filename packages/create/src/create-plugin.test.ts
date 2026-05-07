/**
 * Unit tests for createPlugin() — run inside a temp dir so we never
 * touch the repo's real plugins/ tree.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlugin } from "./create-plugin.js";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("createPlugin", () => {
  let tmp = "";
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "covel-create-plugin-"));
  });
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("rejects invalid names", async () => {
    await expect(
      createPlugin({
        name: "InvalidName",
        template: "zero-code",
        outputDir: tmp,
      }),
    ).rejects.toThrow(/Invalid plugin name/);
  });

  it("writes a zero-code plugin with PLUGIN.md + package.json and nothing else", async () => {
    const result = await createPlugin({
      name: "my-tiny",
      template: "zero-code",
      outputDir: tmp,
    });
    expect(result.success).toBe(true);
    expect(result.name).toBe("my-tiny");
    expect(result.files).toHaveLength(2);
    const pluginMd = await readFile(
      path.join(result.pluginDir, "PLUGIN.md"),
      "utf8",
    );
    expect(pluginMd).toContain("name: my-tiny");
    expect(pluginMd).toContain("trigger:\n  type: manual");
    expect(
      await exists(path.join(result.pluginDir, "tools", "my-tiny-tool.js")),
    ).toBe(false);
  });

  it("writes an agent plugin with a local tool skeleton", async () => {
    const result = await createPlugin({
      name: "my-agent",
      template: "agent",
      outputDir: tmp,
    });
    const toolPath = path.join(result.pluginDir, "tools", "my-agent-tool.js");
    expect(await exists(toolPath)).toBe(true);
    const tool = await readFile(toolPath, "utf8");
    expect(tool).toContain("name: 'my-agent-tool'");
    const pluginMd = await readFile(
      path.join(result.pluginDir, "PLUGIN.md"),
      "utf8",
    );
    expect(pluginMd).toContain("tools:\n  local:");
    expect(pluginMd).toContain("./tools/my-agent-tool.js");
  });

  it("writes a function plugin with a runtime handler", async () => {
    const result = await createPlugin({
      name: "my-fn",
      template: "function",
      outputDir: tmp,
    });
    const runtimePath = path.join(result.pluginDir, "runtime.js");
    expect(await exists(runtimePath)).toBe(true);
    const pluginMd = await readFile(
      path.join(result.pluginDir, "PLUGIN.md"),
      "utf8",
    );
    expect(pluginMd).toContain("runtime:\n  type: function");
    expect(pluginMd).toContain("handler: ./runtime.js");
  });

  it("refuses to overwrite an existing directory unless force is true", async () => {
    await createPlugin({
      name: "twice",
      template: "zero-code",
      outputDir: tmp,
    });
    await expect(
      createPlugin({
        name: "twice",
        template: "zero-code",
        outputDir: tmp,
      }),
    ).rejects.toThrow(/already exists/);
    const forced = await createPlugin({
      name: "twice",
      template: "zero-code",
      outputDir: tmp,
      force: true,
    });
    expect(forced.success).toBe(true);
  });

  it("applies the caller-supplied description and priority", async () => {
    const result = await createPlugin({
      name: "priced",
      template: "agent",
      outputDir: tmp,
      description: "Bespoke description",
      priority: 650,
    });
    const pluginMd = await readFile(
      path.join(result.pluginDir, "PLUGIN.md"),
      "utf8",
    );
    expect(pluginMd).toContain("Bespoke description");
    expect(pluginMd).toContain("priority: 650");
  });
});
