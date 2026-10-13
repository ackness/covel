import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const hookModule = pathToFileURL(
  fileURLToPath(new URL("../src/reload-generation.ts", import.meta.url)),
).href;

/**
 * Vitest evaluates imported files through Vite, where Node's module hooks do
 * not run. The scenario runs in a plain Node process, as the server does.
 */
async function scenario(script: string): Promise<unknown> {
  const parent = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "covel-reload-generation-")),
  );
  roots.push(parent);
  const write = async (file: string, source: string) => {
    const target = path.join(parent, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, source);
  };
  await write("package.json", '{"type":"module"}');
  // Every module counts its evaluations; `helper` also carries a value.
  const counted = (name: string, body = "") =>
    `globalThis.evaluated ??= {};\nglobalThis.evaluated[${JSON.stringify(name)}] = (globalThis.evaluated[${JSON.stringify(name)}] ?? 0) + 1;\n${body}`;
  await write("outside.js", counted("outside"));
  await write("alpha/node_modules/dep/index.js", counted("dep"));
  await write("alpha/lib/legacy.cjs", counted("legacy"));
  await write("alpha/lib/deep.js", counted("deep"));
  await write(
    "alpha/lib/helper.js",
    counted(
      "helper",
      'import "./deep.js";\nimport "./legacy.cjs";\nimport "../../outside.js";\nimport "../node_modules/dep/index.js";\nexport const state = { value: 1 };',
    ),
  );
  for (const module of ["entry", "handler"])
    await write(
      `alpha/${module}.js`,
      'import { state } from "./lib/helper.js";\nexport default state;\nexport const lazy = async () => (await import("./lib/helper.js")).state;',
    );
  await write("beta/lib/helper.js", counted("beta-helper"));
  await write("beta/entry.js", 'import "./lib/helper.js";');
  await write(
    "main.mjs",
    `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { trackReloadGeneration } from ${JSON.stringify(hookModule)};
const root = import.meta.dirname;
const load = async (file, generation) => {
  const url = pathToFileURL(path.join(root, file));
  if (generation) url.searchParams.set("generation", generation);
  return import(url.href);
};
const setHelper = (value) =>
  fs.writeFileSync(
    path.join(root, "alpha/lib/helper.js"),
    fs.readFileSync(path.join(root, "alpha/lib/helper.js"), "utf8").replace(/value: \\d+/, "value: " + value),
  );
const track = (generation, plugin) => trackReloadGeneration(generation, path.join(root, plugin));
const out = {};
${script}
console.log(JSON.stringify({ out, evaluated: globalThis.evaluated }));
`,
  );
  const { stdout } = await run(process.execPath, [
    path.join(parent, "main.mjs"),
  ]);
  return JSON.parse(stdout);
}

describe("reload generation module graph", () => {
  it("re-evaluates the plugin's own relative imports once per tracked generation and nothing else", async () => {
    const result = await scenario(`
const first = await load("alpha/entry.js");
out.startup = first.default.value;
setHelper(2);
track("g2", "alpha");
const entry = await load("alpha/entry.js", "g2");
const handler = await load("alpha/handler.js", "g2");
out.reloaded = entry.default.value;
out.sharedInGeneration = entry.default === handler.default;
out.lazySame = (await entry.lazy()) === entry.default;
out.oldGenerationKept = first.default.value;
setHelper(3);
track("g3", "alpha");
out.again = (await load("alpha/entry.js", "g3")).default.value;
`);
    expect(result).toEqual({
      out: {
        startup: 1,
        reloaded: 2,
        sharedInGeneration: true,
        lazySame: true,
        oldGenerationKept: 1,
        again: 3,
      },
      // helper and deep: startup + two reloads. Files outside the plugin
      // directory, under node_modules, or CommonJS keep one instance.
      evaluated: { helper: 3, deep: 3, outside: 1, dep: 1, legacy: 1 },
    });
  });

  it("leaves an untracked generation and another plugin's generation alone", async () => {
    const result = await scenario(`
await load("alpha/entry.js");
setHelper(2);
// The loader versions direct modules of the first activation as "initial".
out.untracked = (await load("alpha/entry.js", "initial")).default.value;
track("g2", "beta");
await load("beta/entry.js");
await load("beta/entry.js", "g2");
// A generation tracked for beta gives alpha's modules no new copy.
out.otherPlugin = (await load("alpha/handler.js", "g2")).default.value;
`);
    expect(result).toEqual({
      out: { untracked: 1, otherPlugin: 1 },
      evaluated: {
        helper: 1,
        deep: 1,
        outside: 1,
        dep: 1,
        legacy: 1,
        "beta-helper": 2,
      },
    });
  });
});
