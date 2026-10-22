import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  // Inline a trusted test pinset, not a fake verifier: path resolution still
  // runs the production regular-file, metadata, license and SHA256 checks.
  const version = "99.0.0";
  const binaryName = process.platform === "win32" ? "node.exe" : "node";
  const target = `${process.platform}-${process.arch}`;
  const binaryContents = "pinned synthetic runtime fixture";
  const licenseContents = "synthetic upstream license fixture";
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  const binarySha256 = sha256(binaryContents);
  const distributionRoot = `node-v${version}-${target}`;
  const manifest = {
    mode: "standalone",
    version,
    license: { sha256: sha256(licenseContents) },
    targets: {
      [target]: {
        file:
          process.platform === "win32"
            ? "win-x64/node.exe"
            : `${distributionRoot}.tar.gz`,
        ...(process.platform === "win32"
          ? {}
          : { member: `${distributionRoot}/bin/node` }),
        sha256: binarySha256,
        binarySha256,
      },
    },
  };
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
            builder.onResolve({ filter: /node-runtime\.json$/ }, () => ({
              path: "node-runtime.json",
              namespace: "runtime-manifest-fixture",
            }));
            builder.onLoad(
              { filter: /.*/, namespace: "runtime-manifest-fixture" },
              () => ({ contents: JSON.stringify(manifest), loader: "json" }),
            );
          },
        },
      ],
    });
    const { ensureUserPaths, resolveBackendRuntime, resolveServerEntry } =
      await import(pathToFileURL(output).href);
    assert.equal(
      resolveServerEntry(),
      path.join(resources, "server/src/index.js"),
    );
    await fs.mkdir(resources, { recursive: true });
    await fs.writeFile(
      path.join(resources, "runtime-selection.json"),
      JSON.stringify({
        mode: manifest.mode,
        selection: sha256(`desktop-backend-v1:${JSON.stringify(manifest)}`),
        mainSha256: sha256(await fs.readFile(output)),
        platform: process.platform,
        arch: process.arch,
      }),
    );
    const runtime = path.join(resources, "node", binaryName);
    await assert.rejects(
      resolveBackendRuntime,
      /Bundled backend runtime.*Reinstall Covel/,
    );
    const runtimeDirectory = path.dirname(runtime);
    await fs.mkdir(runtimeDirectory, { recursive: true });
    const metadataFile = path.join(runtimeDirectory, "runtime.json");
    const metadata = {
      version,
      platform: process.platform,
      arch: process.arch,
      binary: binaryName,
      binarySha256,
    };
    await fs.writeFile(runtime, binaryContents, { mode: 0o755 });
    await fs.writeFile(path.join(runtimeDirectory, "LICENSE"), licenseContents);
    await fs.writeFile(metadataFile, JSON.stringify(metadata));
    assert.equal(await resolveBackendRuntime(), runtime);
    // Revalidate every resolution; the verifier suite covers each rejection rule.
    await fs.writeFile(runtime, "unexpected replacement runtime");
    await assert.rejects(
      resolveBackendRuntime,
      /Bundled backend runtime.*Reinstall Covel/,
    );
    await fs.writeFile(runtime, binaryContents);
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
