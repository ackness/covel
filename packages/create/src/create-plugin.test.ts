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

  it("writes a zero-code plugin with README.md + PLUGIN.md + package.json and nothing else", async () => {
    const result = await createPlugin({
      name: "my-tiny",
      template: "zero-code",
      outputDir: tmp,
    });
    expect(result.success).toBe(true);
    expect(result.name).toBe("my-tiny");
    expect(result.files).toHaveLength(3);
    const readme = await readFile(
      path.join(result.pluginDir, "README.md"),
      "utf8",
    );
    expect(readme).toContain("# my-tiny");
    expect(readme).toContain("人类和开发者看的说明");
    const pluginMd = await readFile(
      path.join(result.pluginDir, "PLUGIN.md"),
      "utf8",
    );
    expect(pluginMd).toContain("name: my-tiny");
    expect(pluginMd).toContain("trigger:\n  type: manual");
    expect(pluginMd).not.toContain("priority:");
    expect(
      await exists(path.join(result.pluginDir, "tools", "my-tiny-tool.js")),
    ).toBe(false);
  });

  it("ignores caller-supplied priority for zero-code manual plugins", async () => {
    const result = await createPlugin({
      name: "manual-only",
      template: "zero-code",
      outputDir: tmp,
      priority: 650,
    });
    const pluginMd = await readFile(
      path.join(result.pluginDir, "PLUGIN.md"),
      "utf8",
    );
    expect(pluginMd).toContain("trigger:\n  type: manual");
    expect(pluginMd).not.toContain("priority:");
    expect(result.notes).toContain(
      "Zero-code plugins use a manual trigger, so the supplied priority was ignored.",
    );
  });

  it("writes an agent plugin with an entry module and a tool skeleton", async () => {
    const result = await createPlugin({
      name: "my-agent",
      template: "agent",
      outputDir: tmp,
    });
    const toolPath = path.join(result.pluginDir, "tools", "my-agent-tool.js");
    expect(await exists(toolPath)).toBe(true);
    const tool = await readFile(toolPath, "utf8");
    expect(tool).toContain("name: 'my-agent-tool'");
    expect(tool).toContain("export default function");
    expect(tool).toContain("withPendingProposals");
    expect(tool).not.toContain("from 'zod'");
    const entry = await readFile(
      path.join(result.pluginDir, "server", "index.js"),
      "utf8",
    );
    expect(entry).toContain("covel.registerTool(makeTool(covel.toolkit))");
    expect(entry).toContain("from '../tools/my-agent-tool.js'");
    const pluginMd = await readFile(
      path.join(result.pluginDir, "PLUGIN.md"),
      "utf8",
    );
    expect(pluginMd).toContain("entry: ./server/index.js");
    expect(pluginMd).toContain("tools:\n  plugin:\n    - my-agent-tool");
  });

  it.each(["zero-code", "agent", "function"] as const)(
    "never scaffolds deprecated registration frontmatter (%s)",
    async (template) => {
      const result = await createPlugin({
        name: `no-legacy-${template}`,
        template,
        outputDir: tmp,
      });
      const pluginMd = await readFile(
        path.join(result.pluginDir, "PLUGIN.md"),
        "utf8",
      );
      // tools.local / hooks / rpc / wires are deprecated (one release cycle);
      // scaffolded plugins must be born on the unified `entry` pattern.
      expect(pluginMd).not.toMatch(/^\s*local:/m);
      expect(pluginMd).not.toMatch(/^hooks:/m);
      expect(pluginMd).not.toMatch(/^rpc:/m);
      expect(pluginMd).not.toMatch(/^wires:/m);
    },
  );

  it("keeps the checked-in plugin-with-tools template free of deprecated frontmatter", async () => {
    const templateMd = await readFile(
      path.join(
        import.meta.dirname,
        "../../../templates/plugin-with-tools/PLUGIN.md",
      ),
      "utf8",
    );
    expect(templateMd).toContain("entry: ./server/index.js");
    expect(templateMd).not.toMatch(/^\s*local:/m);
    expect(templateMd).not.toMatch(/^hooks:/m);
    expect(templateMd).not.toMatch(/^rpc:/m);
    expect(templateMd).not.toMatch(/^wires:/m);
  });

  it("writes a function plugin with a runtime handler", async () => {
    const result = await createPlugin({
      name: "my-fn",
      template: "function",
      outputDir: tmp,
    });
    const runtimePath = path.join(result.pluginDir, "handler.js");
    expect(await exists(runtimePath)).toBe(true);
    const pluginMd = await readFile(
      path.join(result.pluginDir, "PLUGIN.md"),
      "utf8",
    );
    expect(pluginMd).toContain("runtimeType: function");
    expect(pluginMd).toContain("handler: ./handler.js");
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
