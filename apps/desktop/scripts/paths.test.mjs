import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("packaged paths preserve config ownership and missing resource roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "covel-paths-test-"));
  const previousHome = process.env.COVEL_HOME;
  const previousResources = Object.getOwnPropertyDescriptor(
    process,
    "resourcesPath",
  );
  const home = path.join(root, "home");
  const resources = path.join(root, "resources");
  process.env.COVEL_HOME = home;
  Object.defineProperty(process, "resourcesPath", {
    value: resources,
    configurable: true,
  });
  try {
    const output = path.join(root, "paths.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/paths.ts", import.meta.url))],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "packaged-electron-fixture",
          setup(builder) {
            builder.onResolve({ filter: /^electron$/ }, () => ({
              path: "electron",
              namespace: "fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: "export const app = { isPackaged: true };",
            }));
          },
        },
      ],
    });
    const { ensureUserPaths } = await import(pathToFileURL(output).href);
    const paths = ensureUserPaths();
    assert.equal(paths.userLlmTomlPath, path.join(home, "llm.toml"));
    assert.deepEqual(paths.pluginsDirs, [
      path.join(resources, "server/plugins"),
      path.join(home, "plugins"),
    ]);
    assert.deepEqual(paths.worldsDirs, [
      path.join(resources, "server/worlds"),
      path.join(home, "data/worlds"),
    ]);
    await assert.rejects(fs.access(paths.pluginsDirs[0]), { code: "ENOENT" });
    await fs.access(paths.pluginsDirs[1]);

    // Stale private config in app resources must never seed a new user home.
    await fs.mkdir(path.join(resources, "server"), { recursive: true });
    await fs.writeFile(
      path.join(resources, "server/llm.toml"),
      "# synthetic bundled config\n",
    );
    ensureUserPaths();
    await assert.rejects(fs.access(paths.userLlmTomlPath), { code: "ENOENT" });
    await fs.writeFile(paths.userLlmTomlPath, "# synthetic user config\n");
    assert.equal(ensureUserPaths().userLlmTomlPath, paths.userLlmTomlPath);
    assert.equal(
      await fs.readFile(paths.userLlmTomlPath, "utf8"),
      "# synthetic user config\n",
    );
  } finally {
    if (previousHome === undefined) delete process.env.COVEL_HOME;
    else process.env.COVEL_HOME = previousHome;
    if (previousResources)
      Object.defineProperty(process, "resourcesPath", previousResources);
    else delete process.resourcesPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
