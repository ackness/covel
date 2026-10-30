import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pluginLoader from "@covel/plugin-loader";
import { extractDeclarations } from "./extract-declarations.js";
import { runCli } from "./run-cli.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  code = "export default () => {};",
  header = "description: Fixture\n",
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "extract-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "server"));
  await fs.writeFile(path.join(root, "server/index.js"), code);
  await fs.writeFile(
    path.join(root, "PLUGIN.md"),
    `---\n${header}---\n\nBody\n`,
  );
  return root;
}
async function cli(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout: {
      write(text) {
        stdout += text;
      },
    },
    stderr: {
      write(text) {
        stderr += text;
      },
    },
  });
  return { code, stdout, stderr };
}
const register = `export default (covel) => { covel.registerRpc("new", () => {}); };`;

describe("declaration extraction", () => {
  it("records every registration, deduplicating in first-registration order without invoking handlers", async () => {
    const root = await fixture(
      `
import { modelFacingJson } from "@covel/plugin-handlers-utils";
import { z } from "zod";
export default async (covel) => {
  const handler = () => { throw new Error("handler must not execute"); };
  covel.registerTool(covel.toolkit.tool({ name: "save", description: "Save", parameters: z.object({}), execute: handler }));
  covel.registerRpc("open", handler);
  covel.registerService({ contract: "notes.read@1", handler });
  covel.on("TurnStart", handler);
  covel.on("PreToolUse", handler, { enforce: "pre" });
  covel.on("TurnStart", handler, { enforce: "normal" });
  covel.on("PreToolUse", handler, { enforce: "pre" });
  covel.registerFormValidator("allocation", handler);
  covel.registerWires({ text: [{ id: "text", generateText: handler, streamText: handler }], image: [{ id: "image", generate: handler }] });
  covel.provideExtension("ui.slot@1", "summary", { handler });
  covel.registerRpc("later", handler);
  covel.registerRpc("open", handler);
  covel.registerTool({ name: "save" });
  covel.registerService({ contract: "notes.read@1", handler });
  covel.registerFormValidator("allocation", handler);
  covel.registerWires({ image: [{ id: "image" }] });
  covel.provideExtension("ui.slot@1", "summary", { handler });
  if (modelFacingJson({ ok: true }).ok !== true) throw new Error("host SDK unavailable");
};`,
      "description: Fixture\ncontributes:\n  commands: [{ name: open, action: open, description: Open }]\n",
    );
    expect(await extractDeclarations(root)).toEqual({
      tools: ["save"],
      actions: ["open", "later"],
      services: ["notes.read@1"],
      hooks: ["TurnStart", { event: "PreToolUse", enforce: "pre" }],
      forms: ["allocation"],
      wires: ["text", "image"],
      extensions: ["ui.slot@1/summary"],
      commands: [{ name: "open", action: "open", description: "Open" }],
      localizedContributes: [],
    });
  });

  it("records a model-facing service as an object and round-trips it", async () => {
    const root = await fixture(
      `export default (covel) => {
  const handler = () => null;
  covel.registerService({ contract: "inventory.items@1", modelFacing: true, handler });
  covel.registerService({ contract: "notes.read@1", modelFacing: false, handler });
};`,
    );
    expect((await extractDeclarations(root)).services).toEqual([
      { contract: "inventory.items@1", modelFacing: true },
      "notes.read@1",
    ]);
    expect((await cli(["extract", root])).code).toBe(0);
    const manifest = await fs.readFile(path.join(root, "PLUGIN.md"), "utf8");
    expect(manifest).toContain("modelFacing: true");
    expect(await cli(["extract", root, "--check"])).toMatchObject({ code: 0 });
  });

  it("supports explicit entry paths and awaits async factories and disposal", async () => {
    const root = await fixture(
      `export default async (covel) => {
      await Promise.resolve();
      covel.registerRpc("ready", () => {});
      covel.onDispose(async () => { await Promise.resolve(); });
    };`,
      "entry: ./custom.mjs\n",
    );
    await fs.rename(
      path.join(root, "server/index.js"),
      path.join(root, "custom.mjs"),
    );
    expect((await extractDeclarations(root)).actions).toEqual(["ready"]);
  });

  it("handles a package with no entry", async () => {
    const root = await fixture();
    await fs.rm(path.join(root, "server"), { recursive: true });
    expect((await extractDeclarations(root)).actions).toEqual([]);
  });

  it.each([
    [
      "throwing factory",
      'export default () => { throw new Error("factory failed"); };',
      "",
      "factory failed",
    ],
    [
      "HTTP at registration",
      'export default (covel) => covel.http.fetchWithRetry("https://example.com");',
      "",
      "not available during extraction",
    ],
    [
      "gateway at registration",
      "export default (covel) => covel.gateway.generateText({});",
      "",
      "gateway.generateText is not available during extraction",
    ],
    [
      "store at registration",
      'export default (covel) => covel.store.get("x");',
      "",
      "store.get is not available during extraction",
    ],
    [
      "UI at registration",
      "export default (covel) => covel.ui.show({});",
      "",
      "ui.show is not available during extraction",
    ],
    [
      "timer at registration",
      "export default (covel) => covel.timers.setInterval(() => {}, 10);",
      "",
      "timers.setInterval is not available during extraction",
    ],
    ["invalid export", "export default {};", "", "default-export a function"],
    [
      "path traversal",
      "export default () => {};",
      "entry: ../outside.js\n",
      "entry path escapes plugin root",
    ],
    [
      "invalid registration",
      'export default (covel) => covel.registerRpc("covel:reserved", () => {});',
      "",
      "reserved",
    ],
  ])("fails without writing for %s", async (_label, code, header, message) => {
    const root = await fixture(code, header);
    const file = path.join(root, "PLUGIN.md");
    const original = await fs.readFile(file, "utf8");
    const result = await cli(["extract", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it("rejects an entry symlink outside the package", async () => {
    const root = await fixture();
    const outside = await fixture();
    const file = path.join(root, "server/index.js");
    await fs.rm(file);
    await fs.symlink(path.join(outside, "server/index.js"), file);
    const original = await fs.readFile(path.join(root, "PLUGIN.md"), "utf8");
    expect((await cli(["extract", root])).stderr).toContain(
      "entry path escapes plugin root",
    );
    expect(await fs.readFile(path.join(root, "PLUGIN.md"), "utf8")).toBe(
      original,
    );
  });

  it("disposes every resource after a factory fails and retains the factory error", async () => {
    const root = await fixture(`
import fs from "node:fs/promises";
export default (covel) => {
  covel.onDispose(() => {
    if (!covel.signal.aborted) throw new Error("signal was not aborted");
    return fs.writeFile(new URL("../disposed.txt", import.meta.url), "disposed");
  });
  covel.onDispose(() => { throw new Error("cleanup failed"); });
  throw new Error("factory failed before cleanup");
};`);
    const file = path.join(root, "PLUGIN.md");
    const original = await fs.readFile(file, "utf8");
    const result = await cli(["extract", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("factory failed before cleanup");
    expect(await fs.readFile(path.join(root, "disposed.txt"), "utf8")).toBe(
      "disposed",
    );
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it("rejects executable frontmatter before executing entry code", async () => {
    const root = await fixture('throw new Error("entry executed");');
    const file = path.join(root, "PLUGIN.md");
    const original = "---js\nthrow new Error('frontmatter executed');\n---\n";
    await fs.writeFile(file, original);
    const result = await cli(["extract", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("plain YAML frontmatter");
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it("extracts every bundled entry with no declaration drift (no skips)", async () => {
    const plugins = path.resolve(import.meta.dirname, "../../../plugins");
    const checked: string[] = [];
    for (const directory of await fs.readdir(plugins, {
      withFileTypes: true,
    })) {
      if (!directory.isDirectory()) continue;
      const root = path.join(plugins, directory.name);
      const source = await fs.readFile(path.join(root, "PLUGIN.md"), "utf8");
      const { data } = pluginLoader.readPlainYamlFrontmatter(source);
      const hasDefault = await fs
        .access(path.join(root, "server/index.js"))
        .then(
          () => true,
          () => false,
        );
      if (!data.entry && !hasDefault) continue;
      const extracted = await extractDeclarations(root);
      expect(
        pluginLoader.rewriteContributes(source, extracted).changed,
        directory.name,
      ).toEqual([]);
      expect(extracted.localizedContributes, directory.name).toEqual([]);
      checked.push(directory.name);
    }
    expect(checked.length).toBeGreaterThan(0);
  });
});

describe("extract CLI", () => {
  it.each([
    "contributes:\n  tools: [save]\n",
    "contributes: {tools: [save],}\n",
  ])(
    "adds an action to the existing mapping without corrupting the manifest: %s",
    async (header) => {
      const root = await fixture(
        `export default (covel) => { covel.registerTool({ name: "save" }); covel.registerRpc("new", () => {}); };`,
        header,
      );
      expect((await cli(["extract", root])).code).toBe(0);
      const updated = await fs.readFile(path.join(root, "PLUGIN.md"), "utf8");
      expect(pluginLoader.readPlainYamlFrontmatter(updated).data).toEqual({
        contributes: { tools: ["save"], actions: ["new"] },
      });
      expect((await cli(["extract", root, "--check"])).code).toBe(0);
      expect(await fs.readFile(path.join(root, "PLUGIN.md"), "utf8")).toBe(
        updated,
      );
    },
  );

  it.each([
    "---\ncontributes: {actions: [new],,}\n---\n",
    "---\ncontributes: {}\nactions: [new]\n---\n",
  ])("rejects corrupted rewrite output before writing: %s", async (text) => {
    const root = await fixture(register);
    const file = path.join(root, "PLUGIN.md");
    const original = await fs.readFile(file, "utf8");
    vi.spyOn(pluginLoader, "rewriteContributes").mockReturnValueOnce({
      text,
      changed: ["actions"],
      drift: [{ key: "actions", added: ["new"], removed: [] }],
    });
    const result = await cli(["extract", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toBe("");
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it("checks drift with added and removed names, never writes, and writes only by default", async () => {
    const root = await fixture(register, "contributes:\n  actions: [old]\n");
    const file = path.join(root, "PLUGIN.md");
    const original = await fs.readFile(file, "utf8");
    const check = await cli(["extract", root, "--check"]);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain("@@ contributes.actions @@\n- old\n+ new\n");
    expect(await fs.readFile(file, "utf8")).toBe(original);
    const write = await cli(["extract", root]);
    expect(write.code).toBe(0);
    expect(write.stdout).toContain("Updated PLUGIN.md: actions");
    const updated = await fs.readFile(file, "utf8");
    expect(updated).not.toBe(original);
    expect((await cli(["extract", root, "--check"])).code).toBe(0);
    expect(await fs.readFile(file, "utf8")).toBe(updated);
  });

  it("emits structured JSON and reports localized declarations without touching variants", async () => {
    const root = await fixture(register);
    const variant =
      "---\ncontributes:\n  actions: [translated]\n---\n中文正文\n";
    await fs.writeFile(path.join(root, "PLUGIN.zh.md"), variant);
    await fs.writeFile(path.join(root, "PLUGIN.fr.md"), "---\n---\nFrançais\n");
    const result = await cli(["extract", "--json", root, "--check"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      extracted: { actions: ["new"], localizedContributes: ["PLUGIN.zh.md"] },
      drift: [{ key: "actions", added: ["new"], removed: [] }],
    });
    expect(result.stderr).toContain(
      "PLUGIN.zh.md: registration declarations belong only in canonical PLUGIN.md",
    );
    expect((await cli(["extract", root])).code).toBe(0);
    expect(await fs.readFile(path.join(root, "PLUGIN.zh.md"), "utf8")).toBe(
      variant,
    );
  });

  it.each([["extract"], ["extract", "a", "b"], ["extract", "a", "--unknown"]])(
    "rejects invalid arguments: %s",
    async (...args) => {
      expect((await cli(args)).code).toBe(2);
    },
  );

  it("documents execution permissions in both help paths", async () => {
    for (const args of [["extract", "--help"], ["--help"]]) {
      const result = await cli(args);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("entry code with your permissions");
      expect(result.stdout).toContain("--check");
    }
  });
});
