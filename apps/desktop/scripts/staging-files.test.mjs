import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  assertDesktopBundle,
  detachStagingHardlinks,
  isGalleryOriginal,
  pruneStagedServer,
  verifyBundledNotices,
} from "./staging-files.mjs";
import { build } from "esbuild";
import { Arch } from "electron-builder";

test("staging cache restores cannot overwrite workspace files or the package store", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-stage-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.mjs");
  const staging = path.join(root, "staging");
  const nested = path.join(staging, "node_modules", "runtime");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(source, "original", { encoding: "utf8", mode: 0o755 });
  const artifact = path.join(nested, "source.mjs");
  fs.linkSync(source, artifact);
  const binary = path.join(staging, "native.bin");
  const sharedBinary = path.join(root, "store.bin");
  fs.writeFileSync(sharedBinary, Buffer.from([0, 1, 255]));
  fs.linkSync(sharedBinary, binary);

  assert.equal(detachStagingHardlinks(staging), 2);
  assert.equal(detachStagingHardlinks(staging), 0);
  assert.equal(fs.readFileSync(artifact, "utf8"), "original");
  assert.deepEqual(fs.readFileSync(binary), Buffer.from([0, 1, 255]));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(artifact).mode & 0o777, 0o755);
  }

  fs.writeFileSync(source, "edited workspace", "utf8");
  assert.equal(fs.readFileSync(artifact, "utf8"), "original");
  // Simulate an in-place Turbo cache extraction onto the existing artifact.
  fs.writeFileSync(artifact, "cached artifact", "utf8");
  fs.writeFileSync(binary, Buffer.from([42]));
  assert.equal(fs.readFileSync(source, "utf8"), "edited workspace");
  assert.deepEqual(fs.readFileSync(sharedBinary), Buffer.from([0, 1, 255]));
});

test("only a gallery PNG with a WebP beside it is left out of the package", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-stage-gallery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gallery = path.join(root, "worlds", "demo", "media", "gallery");
  const portraits = path.join(root, "worlds", "demo", "media", "portraits");
  fs.mkdirSync(gallery, { recursive: true });
  fs.mkdirSync(portraits, { recursive: true });
  for (const file of [
    path.join(gallery, "map.png"),
    path.join(gallery, "map.webp"),
    path.join(gallery, "only-png.png"),
    path.join(portraits, "hero.png"),
    path.join(portraits, "hero.webp"),
  ])
    fs.writeFileSync(file, "x");

  assert.equal(isGalleryOriginal(path.join(gallery, "map.png")), true);
  assert.equal(isGalleryOriginal(path.join(gallery, "map.webp")), false);
  assert.equal(isGalleryOriginal(path.join(gallery, "only-png.png")), false);
  assert.equal(isGalleryOriginal(path.join(portraits, "hero.png")), false);
});

test("packaging stages the runtime for each target, never the build host", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-stage-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "hook.mjs");
  await build({
    stdin: {
      contents:
        'export { default as beforePack } from "./before-pack.mjs"; export { calls } from "./backend-runtime.mjs";',
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      sourcefile: "target-runtime-fixture.mjs",
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "runtime-download-fixture",
        setup(builder) {
          builder.onResolve(
            { filter: /^(\.\/backend-runtime\.mjs|electron-builder)$/ },
            (args) => ({
              path: args.path,
              namespace: "fixture",
            }),
          );
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents:
              args.path === "electron-builder"
                ? `export const Arch = ${JSON.stringify(Arch)};`
                : `export const calls = [];
               export const BACKEND_RUNTIME_MODE = "standalone";
               export function probeBackendRuntime() { throw new Error("standalone packaging must not probe Electron"); }
               export async function stageBackendRuntime(directory, target, executableName) { calls.push(["stage", directory, target, executableName]); }`,
          }));
        },
      },
    ],
  });
  const { beforePack, calls } = await import(pathToFileURL(output).href);
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["win32", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
  ]) {
    calls.length = 0;
    const context = {
      electronPlatformName: platform,
      arch: Arch[arch],
      packager: { projectDir: root, appInfo: { productFilename: "Covel" } },
    };
    const modules = path.join(root, "staging", "server", "node_modules");
    const esbuildDirectory = path.join(
      modules,
      "@esbuild",
      `${platform}-${arch}`,
    );
    fs.mkdirSync(esbuildDirectory, { recursive: true });
    fs.writeFileSync(path.join(esbuildDirectory, "package.json"), "{}");
    // Other targets from previous iterations and a package manifest must not
    // make this target pass without its actual native binaries.
    await assert.rejects(beforePack(context), /native dependency:.*esbuild/);
    assert.equal(calls.length, 0);
    const esbuildBinary = path.join(
      esbuildDirectory,
      platform === "win32" ? "esbuild.exe" : "bin/esbuild",
    );
    fs.mkdirSync(path.dirname(esbuildBinary), { recursive: true });
    fs.writeFileSync(esbuildBinary, "synthetic native path fixture", {
      mode: 0o755,
    });
    await assert.rejects(beforePack(context), /native dependency:.*sqlite-vec/);
    assert.equal(calls.length, 0);
    const vectorPlatform = platform === "win32" ? "windows" : platform;
    const vectorSuffix = { darwin: "dylib", win32: "dll", linux: "so" }[
      platform
    ];
    const vectorBinary = path.join(
      modules,
      `sqlite-vec-${vectorPlatform}-${arch}`,
      `vec0.${vectorSuffix}`,
    );
    fs.mkdirSync(path.dirname(vectorBinary), { recursive: true });
    fs.writeFileSync(vectorBinary, "");
    await assert.rejects(beforePack(context), /native dependency:.*sqlite-vec/);
    assert.equal(calls.length, 0);
    fs.writeFileSync(vectorBinary, "synthetic extension path fixture");
    fs.mkdirSync(path.join(modules, "@covel"), { recursive: true });
    pruneStagedServer(path.dirname(modules), []);
    await beforePack(context);
    assert.deepEqual(calls, [["stage", root, { platform, arch }, "Covel"]]);
  }
  for (const [platform, arch] of [
    ["freebsd", Arch.x64],
    ["win32", Arch.ia32],
  ]) {
    await assert.rejects(
      beforePack({
        electronPlatformName: platform,
        arch,
        packager: { projectDir: root },
      }),
      /Unsupported desktop Node target/,
    );
  }
});

test("pruning preserves runtime data, source packages and every native target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-prune-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const retained = [
    "node_modules/postgres/src/index.js",
    "node_modules/sprintf-js/src/sprintf.js",
    "node_modules/undici/types/runtime.js",
    "node_modules/undici/lib/milo/LICENSE.md",
    "node_modules/zod/src/v4/core/index.ts",
    "node_modules/zod/v4/locales/zh-CN.js",
    "node_modules/@covel/fixture/data/tests.json",
    "node_modules/@covel/fixture/data/snapshot.txt",
    "plugins/example/tests/data.ts",
    "worlds/example/data/types.d.ts",
    "node_modules/unreviewed/test/data.js",
    "node_modules/unreviewed/index.d.ts",
    "node_modules/@esbuild/linux-x64/bin/esbuild",
    "node_modules/@esbuild/linux-arm64/bin/esbuild",
    "node_modules/sqlite-vec-linux-x64/vec0.so",
    "node_modules/sqlite-vec-linux-arm64/vec0.so",
  ];
  const removed = [
    "node_modules/.pnpm/unused/package.json",
    "node_modules/postgres/types/index.d.ts",
    "node_modules/undici/types/index.d.ts",
    "node_modules/zod/index.d.cts",
    "node_modules/zod/src/v4/core/tests/example.test.ts",
    "node_modules/fast-uri/test/uri.test.js",
    "node_modules/@covel/fixture/tests/__snapshots__/result.txt",
    "node_modules/@covel/fixture/src/example.test.ts",
  ];
  for (const filename of [...retained, ...removed]) {
    const target = path.join(root, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "preserved bytes", { mode: 0o755 });
  }
  pruneStagedServer(root, []);
  for (const filename of retained) {
    const target = path.join(root, filename);
    assert.equal(fs.readFileSync(target, "utf8"), "preserved bytes", filename);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  }
  for (const filename of removed)
    assert.equal(fs.existsSync(path.join(root, filename)), false, filename);
});

test("pruning rejects retained links and wrappers into the pnpm store before deleting anything", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-prune-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modules = path.join(root, "node_modules");
  fs.mkdirSync(path.join(modules, "@covel"), { recursive: true });
  const storePackage = path.join(modules, ".pnpm/runtime");
  fs.mkdirSync(storePackage, { recursive: true });
  fs.writeFileSync(path.join(storePackage, "index.js"), "module.exports = 42;");
  const runtime = path.join(modules, "runtime");
  fs.symlinkSync(storePackage, runtime, "junction");
  assert.throws(() => pruneStagedServer(root, []), /runtime link/);
  assert.equal(
    fs.readFileSync(path.join(runtime, "index.js"), "utf8"),
    "module.exports = 42;",
  );
  fs.unlinkSync(runtime);
  fs.symlinkSync(path.dirname(root), runtime, "junction");
  assert.throws(() => pruneStagedServer(root, []), /external files/);
  fs.unlinkSync(runtime);
  fs.mkdirSync(path.join(modules, ".bin"));
  const wrapper = path.join(modules, ".bin/runtime");
  fs.writeFileSync(
    wrapper,
    '#!/bin/sh\nexec node "$basedir/../.pnpm/runtime/index.js"',
  );
  assert.throws(() => pruneStagedServer(root, []), /references .pnpm/);
  assert.equal(fs.existsSync(storePackage), true);
  fs.rmSync(wrapper);
  const runtimeFile = path.join(modules, "explicit-store-import.cjs");
  fs.writeFileSync(
    runtimeFile,
    'module.exports = require("./.pnpm/runtime/index.js");',
  );
  assert.throws(() => pruneStagedServer(root, []), /references .pnpm/);
  assert.equal(fs.existsSync(storePackage), true);
  fs.rmSync(runtimeFile);
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, "index.js"), "module.exports = 42;");
  fs.symlinkSync(runtime, path.join(modules, "alias"), "junction");
  pruneStagedServer(root, []);
  assert.equal(
    fs.readFileSync(path.join(modules, "alias/index.js"), "utf8"),
    "module.exports = 42;",
  );
  assert.equal(fs.existsSync(storePackage), false);
});

test("pruning a symlinked staging root keeps safe aliases but rejects removed and external paths", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "covel-prune-root-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const physicalRoot = path.join(directory, "physical");
  fs.mkdirSync(path.join(physicalRoot, "node_modules/@covel"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(physicalRoot, "src"));
  const root = path.join(directory, "staging");
  fs.symlinkSync(physicalRoot, root, "junction");
  const source = path.join(root, "src/index.ts");
  fs.writeFileSync(source, "export const value: number = 42;");
  fs.writeFileSync(path.join(root, "src/index.js"), "exports.value = 42;");

  const modules = path.join(root, "node_modules");
  const runtime = path.join(modules, "runtime");
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, "index.js"), "module.exports = 42;");
  fs.symlinkSync(runtime, path.join(modules, "alias"), "junction");

  const store = path.join(modules, ".pnpm");
  fs.mkdirSync(store);
  const storeLink = path.join(store, "runtime");
  fs.symlinkSync(runtime, storeLink, "junction");
  const unsafe = path.join(modules, "unsafe");
  fs.symlinkSync(storeLink, unsafe, "junction");
  assert.throws(() => pruneStagedServer(root, [source]), /runtime link/);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(store), true);
  fs.unlinkSync(unsafe);

  const external = path.join(directory, "physical-external");
  fs.mkdirSync(external);
  fs.symlinkSync(external, unsafe, "junction");
  assert.throws(() => pruneStagedServer(root, [source]), /external files/);
  assert.equal(fs.existsSync(source), true);
  fs.unlinkSync(unsafe);

  pruneStagedServer(root, [source]);
  assert.equal(
    fs.readFileSync(path.join(modules, "alias/index.js"), "utf8"),
    "module.exports = 42;",
  );
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(store), false);
  assert.equal(fs.existsSync(external), true);
});

test("desktop bundle validation refuses an emitted package import", async () => {
  const bundled = await build({
    stdin: {
      contents:
        'import { readFileSync } from "node:fs"; import { app } from "electron"; export { readFileSync, app };',
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    external: ["electron"],
  });
  assertDesktopBundle(bundled.metafile);
  const external = await build({
    stdin: { contents: 'export { fetch } from "undici";' },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    external: ["undici"],
  });
  assert.throws(
    () => assertDesktopBundle(external.metafile),
    /still imports undici/,
  );
});

test("bundled notices require identical staged versions and license bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-bundle-notices-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source/undici");
  const staging = path.join(root, "staging");
  const stagedPackage = path.join(staging, "node_modules/undici");
  for (const directory of [source, stagedPackage]) {
    fs.mkdirSync(path.join(directory, "lib/milo"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "undici", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(directory, "LICENSE"), "MIT notice");
    fs.writeFileSync(path.join(directory, "lib/milo/LICENSE.md"), "ISC notice");
  }
  // A nested, unlisted package must still reach the parent package's notices.
  fs.mkdirSync(path.join(source, "lib/nested"));
  fs.writeFileSync(
    path.join(source, "lib/nested/package.json"),
    JSON.stringify({ name: "internal-module" }),
  );
  const metafiles = [
    {
      inputs: {
        [path.join(source, "lib/nested/client.js")]: {},
        [path.join(source, "lib/nested/request.js")]: {},
        [path.join(source, "lib/client.js")]: {},
      },
    },
  ];
  const readFileSync = fs.readFileSync;
  let sourceManifestReads = 0;
  const read = t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === path.join(source, "package.json")) sourceManifestReads++;
    return readFileSync(file, ...args);
  });
  verifyBundledNotices(metafiles, root, staging);
  assert.equal(sourceManifestReads, 1);
  read.mock.restore();
  fs.writeFileSync(
    path.join(stagedPackage, "lib/milo/LICENSE.md"),
    "different notice",
  );
  assert.throws(
    () => verifyBundledNotices(metafiles, root, staging),
    /notice mismatch/,
  );
  fs.writeFileSync(
    path.join(stagedPackage, "lib/milo/LICENSE.md"),
    "ISC notice",
  );
  fs.writeFileSync(
    path.join(stagedPackage, "package.json"),
    JSON.stringify({ name: "undici", version: "2.0.0" }),
  );
  assert.throws(
    () => verifyBundledNotices(metafiles, root, staging),
    /version mismatch/,
  );
});
