import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

/** Bundle the importer with its install directories pointed at `target`. */
async function loadImporter(root, target) {
  const output = path.join(root, "importer.mjs");
  await build({
    entryPoints: [
      fileURLToPath(new URL("../src/import-assets.ts", import.meta.url)),
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "import-path-fixture",
        setup(builder) {
          builder.onResolve({ filter: /\/paths\.js$/ }, () => ({
            path: "paths",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `export const userPluginsDir = () => ${JSON.stringify(target)}; export const userWorldsDir = userPluginsDir;`,
          }));
        },
      },
    ],
  });
  return import(pathToFileURL(output).href);
}

test("directory imports reject linked manifests and recover from copy failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-import-test-"));
  const target = path.join(root, "installed");
  const source = path.join(root, "world-package");
  const originalCopy = fs.copyFileSync;
  try {
    const { importAsset } = await loadImporter(root, target);
    fs.mkdirSync(source);
    const manifest = path.join(root, "world.yaml");
    fs.writeFileSync(manifest, "id: fixture-world\n", "utf8");
    fs.symlinkSync(manifest, path.join(source, "world.yaml"));
    assert.equal((await importAsset("world", source)).ok, false);
    // Copying an ancestor of the destination would recursively copy its own staging.
    assert.equal((await importAsset("world", root)).ok, false);
    assert.deepEqual(fs.readdirSync(target), []);
    fs.unlinkSync(path.join(source, "world.yaml"));
    fs.copyFileSync(manifest, path.join(source, "world.yaml"));
    fs.writeFileSync(path.join(source, "z-data.json"), "{}", "utf8");
    fs.copyFileSync = (...args) => {
      if (path.basename(args[0]) === "z-data.json")
        throw new Error("Synthetic copy failure");
      return originalCopy(...args);
    };
    assert.equal((await importAsset("world", source)).ok, false);
    assert.deepEqual(fs.readdirSync(target), []);
    fs.copyFileSync = originalCopy;
    assert.equal((await importAsset("world", source)).ok, true);
    assert.equal(
      fs.readFileSync(path.join(target, "world-package/world.yaml"), "utf8"),
      "id: fixture-world\n",
    );
    assert.equal((await importAsset("world", source)).ok, false);
  } finally {
    fs.copyFileSync = originalCopy;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin imports accept only the layout plugin discovery loads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-import-test-"));
  const target = path.join(root, "installed");
  try {
    const { importAsset } = await loadImporter(root, target);
    const write = (file, text = "---\nid: fixture\n---\n") => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, "utf8");
    };

    // The retired layout has no root manifest; discovery refuses it.
    const retired = path.join(root, "retired");
    write(path.join(retired, "runtimes/main/PLUGIN.md"));
    assert.equal((await importAsset("plugin", retired)).ok, false);

    // A root manifest does not excuse a runtime manifest with the old name.
    const mixed = path.join(root, "mixed");
    write(path.join(mixed, "PLUGIN.md"));
    write(path.join(mixed, "runtimes/main/PLUGIN.md"));
    assert.equal((await importAsset("plugin", mixed)).ok, false);
    assert.deepEqual(fs.readdirSync(target), []);

    const current = path.join(root, "current");
    write(path.join(current, "PLUGIN.md"));
    write(path.join(current, "runtimes/main/RUNTIME.md"));
    assert.equal((await importAsset("plugin", current)).ok, true);
    assert.deepEqual(fs.readdirSync(target), ["current"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
