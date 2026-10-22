import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { compileStagedServer } from "./compile-server.mjs";
import { pruneStagedServer } from "./staging-files.mjs";

test("precompiled workspace exports preserve package assets and run without TypeScript", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "covel-compiled-server-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dependency = path.join(root, "node_modules/@covel/fixture");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(dependency, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  const exports = {
    ".": { types: "./src/index.ts", import: "./src/index.ts" },
    "./sub": "./src/sub.ts",
  };
  await fs.writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({ type: "module", exports }),
  );
  await fs.writeFile(
    path.join(dependency, "asset.json"),
    '{"label":"preserved"}',
  );
  await fs.writeFile(
    path.join(dependency, "src/index.ts"),
    'import { readFileSync } from "node:fs"; import { sub } from "./sub.js"; export const value: string = JSON.parse(readFileSync(new URL("../asset.json", import.meta.url), "utf8")).label + sub;',
  );
  await fs.writeFile(
    path.join(dependency, "src/sub.ts"),
    'export const sub: string = "-sub";',
  );
  await fs.writeFile(
    path.join(root, "src/index.ts"),
    'import { value } from "@covel/fixture"; import { sub } from "@covel/fixture/sub"; console.log(value + sub);',
  );
  const compiledSources = await compileStagedServer(root);
  assert.deepEqual(compiledSources, [
    path.join(dependency, "src/index.ts"),
    path.join(dependency, "src/sub.ts"),
    path.join(root, "src/index.ts"),
  ]);
  const manifest = JSON.parse(
    await fs.readFile(path.join(dependency, "package.json"), "utf8"),
  );
  assert.deepEqual(manifest.exports, {
    ".": { types: "./src/index.ts", import: "./src/index.js" },
    "./sub": "./src/sub.js",
  });
  pruneStagedServer(root, compiledSources);
  await assert.rejects(fs.access(path.join(root, "src/index.ts")), {
    code: "ENOENT",
  });
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src/index.js")],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "preserved-sub-sub");
});

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "covel-compile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "node_modules/@covel"), { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(root, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
  }
  return root;
}

test("mixed source trees retain JavaScript, assets, exclusions and export conditions", async (t) => {
  const manifest = {
    type: "module",
    main: "./src/index.ts",
    exports: {
      ".": {
        types: "./src/index.ts",
        node: {
          import: ["./src/index.ts", "./src/existing.js"],
          default: null,
        },
      },
    },
  };
  const files = {
    "package.json": JSON.stringify(manifest),
    "src/index.ts":
      'import { value } from "./nested/value.js"; export { value };',
    "src/nested/value.ts": "export const value: number = 42;",
    "src/existing.js": "export const existing = true; // keep exact bytes\n",
    "src/existing.mjs": "export const esm = true;\n",
    "src/existing.cjs": "module.exports = true;\n",
    "src/asset.json": '{"keep":true}',
    "src/component.tsx": "not compiled",
    "src/module.mts": "not compiled",
    "src/module.cts": "not compiled",
    "src/types.d.ts": "not compiled",
    "src/value.test.ts": "not compiled",
    "src/value.spec.ts": "not compiled",
    "src/tests/invalid.ts": "not compiled",
    "src/__tests__/invalid.ts": "not compiled",
    "src/node_modules/invalid.ts": "not compiled",
    "node_modules/third-party/src/invalid.ts": "not compiled",
    "node_modules/@covel/prebuilt/package.json": '{"main":"./dist/index.js"}',
    "node_modules/@covel/prebuilt/dist/index.js": "export const sdk = true;",
  };
  const root = await fixture(t, files);
  const sources = await compileStagedServer(root);
  assert.deepEqual(
    sources,
    ["src/index.ts", "src/nested/value.ts"].map((file) =>
      path.join(root, file),
    ),
  );
  for (const [relative, content] of Object.entries(files)) {
    if (relative !== "package.json") {
      assert.equal(
        await fs.readFile(path.join(root, relative), "utf8"),
        content,
      );
    }
    if (content === "not compiled") {
      await assert.rejects(
        fs.access(path.join(root, relative.replace(/\.[^.]+$/, ".js"))),
        { code: "ENOENT" },
      );
    }
  }
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
    {
      ...manifest,
      main: "./src/index.js",
      exports: {
        ".": {
          types: "./src/index.ts",
          node: {
            import: ["./src/index.js", "./src/existing.js"],
            default: null,
          },
        },
      },
    },
  );
});

for (const failureStage of ["read", "write"]) {
  test(
    `${failureStage} failure waits for an active output write before rejecting`,
    { timeout: 5000 },
    async (t) => {
      const manifest = '{"type":"module","main":"./src/a-slow.ts"}';
      const root = await fixture(t, {
        "package.json": manifest,
        "src/a-slow.ts": "export const value: number = 1;",
        "src/b-fail.ts": "export const value: number = 2;",
      });
      const slowStarted = Promise.withResolvers();
      const releaseSlow = Promise.withResolvers();
      const failureStarted = Promise.withResolvers();
      const failure = new Error(`injected ${failureStage} failure`);
      const readFile = fs.readFile.bind(fs);
      const writeFile = fs.writeFile.bind(fs);
      let slowFinished = false;
      const fail = async () => {
        await slowStarted.promise;
        failureStarted.resolve();
        throw failure;
      };
      t.mock.method(fs, "readFile", async (filename, ...args) => {
        if (
          failureStage === "read" &&
          filename === path.join(root, "src/b-fail.ts")
        )
          return fail();
        return readFile(filename, ...args);
      });
      t.mock.method(fs, "writeFile", async (filename, ...args) => {
        if (
          failureStage === "write" &&
          filename === path.join(root, "src/b-fail.js")
        )
          return fail();
        if (filename === path.join(root, "src/a-slow.js")) {
          slowStarted.resolve();
          await releaseSlow.promise;
          await writeFile(filename, ...args);
          slowFinished = true;
          return;
        }
        return writeFile(filename, ...args);
      });
      let settled = false;
      const compilation = compileStagedServer(root).finally(() => {
        settled = true;
      });
      const rejection = assert.rejects(
        compilation,
        (error) => error === failure,
      );
      try {
        await failureStarted.promise;
        await setImmediate();
        assert.equal(
          settled,
          false,
          "caller must not observe rejection while writes are active",
        );
        assert.equal(slowFinished, false);
      } finally {
        releaseSlow.resolve();
        await rejection;
      }
      assert.equal(slowFinished, true);
      assert.equal(
        await fs.readFile(path.join(root, "package.json"), "utf8"),
        manifest,
      );
      for (const source of ["a-slow.ts", "b-fail.ts"])
        await fs.access(path.join(root, "src", source));
    },
  );
}

test("invalid TypeScript rejects without pruning sources or rewriting exports", async (t) => {
  const manifest = '{"type":"module","exports":"./src/valid.ts"}';
  const root = await fixture(t, {
    "package.json": manifest,
    "src/valid.ts": "export const value: number = 1;",
    "src/invalid.ts": "export const = ;",
  });
  await assert.rejects(compileStagedServer(root), /Transform failed/);
  assert.equal(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
    manifest,
  );
  await fs.access(path.join(root, "src/valid.ts"));
  await fs.access(path.join(root, "src/invalid.ts"));
});
