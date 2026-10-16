/**
 * The smallest plugin is one PLUGIN.md: a description, a stage and a prompt.
 * The loader works out the ID from the directory, the kind, the runtime type,
 * the default handler and entry, and the contracts and tags; a plugin needs
 * no package.json, and its `.js` files still load as ES modules.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";
import { discoverPluginAt, loadPluginDefinition } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "covel-minimal-"));
  roots.push(root);
  return root;
}

async function files(root: string, entries: Record<string, string>) {
  for (const [name, content] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
}

async function validate(dir: string) {
  let stdout = "";
  let stderr = "";
  const status = await runValidateManifest([dir], {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { status, stdout, stderr };
}

const MINIMAL = `---
description: Adds a short observation after each turn.
runtime:
  schedule: { stage: post-turn }
---
Write one short observation grounded in the latest narrative.
`;

describe("the smallest plugin", () => {
  it("loads and validates one PLUGIN.md with a description, a stage and a prompt", async () => {
    const dir = path.join(await temp(), "observer");
    await files(dir, { "PLUGIN.md": MINIMAL });

    const definition = await loadPluginDefinition(
      (await discoverPluginAt(dir))!,
    );
    expect(definition.packageManifest.plugin).toMatchObject({
      id: "observer",
      kind: "plugin",
      tags: ["cost:llm"],
    });
    expect(definition.packageManifest.plugin.entry).toBeUndefined();
    const [runtime] = definition.manifests;
    expect(runtime?.manifest).toMatchObject({
      name: "observer",
      pluginId: "observer",
      runtimeType: "agent",
      stage: "post-turn",
    });
    expect(runtime?.promptTemplate).toContain("Write one short observation");

    const result = await validate(dir);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).not.toContain("warning:");
  });

  it("works out the entry, the handler, the type, the contracts and the tags", async () => {
    const dir = path.join(await temp(), "tally");
    await files(dir, {
      "PLUGIN.md": `---
description: Counts turns.
contributes:
  ui:
    right: [./panel.json]
runtime:
  schedule: { stage: post-turn }
  io:
    output: { contract: tally@1 }
  function: {}
---
`,
      "handler.js": "export default () => ({ outcome: 'success' });",
      "server/index.js": "export default () => {};",
      "panel.json": JSON.stringify({
        id: "tally",
        view: { component: "Text", props: { content: "Tally" } },
      }),
    });

    const definition = await loadPluginDefinition(
      (await discoverPluginAt(dir))!,
    );
    expect(definition.packageManifest.plugin).toMatchObject({
      id: "tally",
      entry: "./server/index.js",
      provides: ["tally@1"],
      tags: ["cost:function", "ui:right-panel"],
    });
    expect(definition.manifests[0]?.manifest).toMatchObject({
      runtimeType: "function",
      handler: "./handler.js",
    });
    expect(await validate(dir)).toMatchObject({ status: 0, stderr: "" });
  });

  it("leaves out a function runtime that has no handler.js and names the file", async () => {
    const dir = path.join(await temp(), "tally");
    await files(dir, {
      "PLUGIN.md": `---
description: Counts turns.
runtime:
  schedule: { stage: post-turn }
  function: {}
---
`,
    });
    const definition = await loadPluginDefinition(
      (await discoverPluginAt(dir))!,
    );
    expect(definition.manifests).toEqual([]);
    expect(definition.disabledRuntimes[0]?.message).toContain(
      "runtime.function.handler: not written, and there is no ./handler.js next to this file",
    );
    const result = await validate(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("./handler.js");
  });

  it("refuses a written id that differs from the directory name", async () => {
    const dir = path.join(await temp(), "observer");
    await files(dir, {
      "PLUGIN.md": MINIMAL.replace(/^---\n/, "---\nid: other\n"),
    });
    await expect(
      loadPluginDefinition((await discoverPluginAt(dir))!),
    ).rejects.toThrow("id must match");
  });
});

describe("a plugin without package.json", () => {
  // A plain `node` process, not the test runner: Node itself picks the
  // module format here.
  it("loads its .js files as ES modules under a CommonJS package.json", async () => {
    const root = await temp();
    await files(root, {
      "plugins/package.json": JSON.stringify({ type: "commonjs" }),
      "plugins/tally/PLUGIN.md": "---\ndescription: Tally\n---\n",
      "plugins/tally/runtimes/count/handler.js":
        "export default function count() { return 42; }\n",
      "plugins/other/handler.js":
        "export default function other() { return 0; }\n",
      "probe.mjs": `
import { pathToFileURL } from "node:url";
const [hostModules, plugins] = process.argv.slice(2);
const { provideHostModules } = await import(pathToFileURL(hostModules).href);
const load = async (file) => {
  try {
    const module = await import(pathToFileURL(plugins + file).href + "?generation=1");
    return module.default();
  } catch (error) {
    return error.name;
  }
};
// A directory the host was not told about keeps Node's own rule.
const before = await load("/other/handler.js");
provideHostModules(plugins + "/tally");
const after = await load("/tally/runtimes/count/handler.js");
console.log(JSON.stringify({ before, after }));
`,
    });
    // Keep Node's own JS format handling; only resolve this TS helper explicitly.
    await files(root, {
      "host-modules.ts": (
        await readFile(
          path.resolve(import.meta.dirname, "../src/host-modules.ts"),
          "utf8",
        )
      ).replace(
        '"./path-containment.js"',
        JSON.stringify(
          new URL("../src/path-containment.ts", import.meta.url).href,
        ),
      ),
    });
    const output = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        [
          path.join(root, "probe.mjs"),
          path.join(root, "host-modules.ts"),
          path.join(root, "plugins"),
        ],
        (error, stdout, stderr) =>
          error ? reject(new Error(stderr || error.message)) : resolve(stdout),
      ),
    );
    expect(JSON.parse(output)).toEqual({ before: "SyntaxError", after: 42 });
  });
});
