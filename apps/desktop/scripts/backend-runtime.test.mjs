import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { ensureElectronBinary } from "./ensure-electron.mjs";

const scripts = fileURLToPath(new URL(".", import.meta.url));
const sourceManifest = JSON.parse(
  fs.readFileSync(new URL("../node-runtime.json", import.meta.url), "utf8"),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binary = "synthetic pinned Node binary";
const license = "synthetic pinned Node license";
const target = { platform: "linux", arch: "x64" };
const eligible = { node: "24.22.1", electron: "45.0.1", ...target };
const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const fuseWire = (state = 49, version = 1) =>
  Buffer.concat([sentinel, Buffer.from([version, 1, state])]);

async function fixture(t, mode, { root, probeVersions } = {}) {
  root ??= fs.mkdtempSync(path.join(os.tmpdir(), "covel-backend-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = structuredClone(sourceManifest);
  manifest.mode = mode;
  manifest.license.sha256 = hash(license);
  for (const artifact of Object.values(manifest.targets))
    artifact.binarySha256 = hash(binary);
  const output = path.join(root, `runtime-${mode}.mjs`);
  await build({
    stdin: {
      contents: `export * from "./backend-runtime.mjs";
        export { RUNTIME_SELECTION_ID, assertSafeElectronVersions, assertElectronRunAsNodeCapability, verifyRuntimeSelection } from "../src/backend-runtime.ts";
        export { stageCalls } from "./node-runtime.mjs";`,
      resolveDir: scripts,
      sourcefile: "runtime-selection-fixture.mjs",
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "isolated-runtime-inputs",
        setup(builder) {
          builder.onResolve({ filter: /node-runtime\.json$/ }, () => ({
            path: "manifest",
            namespace: "inputs",
          }));
          builder.onResolve({ filter: /^\.\/node-runtime\.mjs$/ }, () => ({
            path: "stage",
            namespace: "inputs",
          }));
          if (probeVersions)
            builder.onResolve({ filter: /^node:child_process$/ }, () => ({
              path: "probe",
              namespace: "inputs",
            }));
          builder.onLoad(
            { filter: /.*/, namespace: "inputs" },
            ({ path: input }) => {
              if (input === "manifest")
                return { contents: JSON.stringify(manifest), loader: "json" };
              if (input === "probe")
                return {
                  contents: `export function execFileSync(executable, args, options) {
            globalThis.__runtimeProbe = { executable, args, options };
            return JSON.stringify(${JSON.stringify(probeVersions)});
          }`,
                };
              return {
                contents: `import fs from "node:fs"; import path from "node:path";
            export const stageCalls = [];
            export async function stageNodeRuntime(directory, target) {
              stageCalls.push({directory, target});
              fs.mkdirSync(directory, {recursive:true});
              const binaryName = target.platform === "win32" ? "node.exe" : "node";
              fs.writeFileSync(path.join(directory,binaryName), ${JSON.stringify(binary)}, {mode:0o755});
              fs.writeFileSync(path.join(directory,"LICENSE"), ${JSON.stringify(license)});
              fs.writeFileSync(path.join(directory,"runtime.json"), JSON.stringify({
                version:${JSON.stringify(manifest.version)}, ...target, binary:binaryName, binarySha256:${JSON.stringify(hash(binary))}
              }));
            }`,
              };
            },
          );
        },
      },
    ],
  });
  const runtime = await import(
    `${pathToFileURL(output).href}?fixture=${Math.random()}`
  );
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  return { ...runtime, root, manifest };
}

function bundle(f, contents = `bundled ${f.BACKEND_RUNTIME_MODE} main`) {
  fs.writeFileSync(path.join(f.root, "dist/main.mjs"), contents);
  f.writeRuntimeBundleSelection(f.root);
}

function electronFile(f, platform = "linux") {
  const executable =
    platform === "darwin"
      ? path.join(f.root, "Covel.app/Contents/MacOS/Covel")
      : path.join(f.root, "exact electron executable");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, fuseWire());
  if (platform === "darwin") {
    const framework = path.join(
      f.root,
      "Covel.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
    );
    fs.mkdirSync(path.dirname(framework), { recursive: true });
    fs.writeFileSync(framework, fuseWire());
  }
  return executable;
}

test("stable supported Node release lines fail closed at their exact patch boundaries", async (t) => {
  const f = await fixture(t, "electron");
  for (const node of ["24.22.1", "24.22.2", "24.23.0", "26.12.1", "26.13.0"]) {
    assert.doesNotThrow(() =>
      f.assertSafeElectronVersions({ node, electron: "45.0.0" }),
    );
  }
  for (const node of [
    undefined,
    "",
    "24.22.0",
    "24.21.99",
    "26.12.0",
    "26.11.99",
    "22.99.99",
    "25.99.99",
    "27.0.0",
    "28.0.0",
    "24.22.1-rc.1",
    "26.12.1+build",
    "v24.22.1",
    "024.22.1",
    "24.22.1\n",
  ]) {
    assert.throws(
      () => f.assertSafeElectronVersions({ node, electron: "45.0.0" }),
      /Unsafe or unsupported/,
    );
  }
  for (const electron of [
    undefined,
    "45.0.0-beta.1",
    "v45.0.0",
    "45.0.0+build",
  ]) {
    assert.throws(
      () => f.assertSafeElectronVersions({ node: "24.22.1", electron }),
      /Unsafe or unsupported/,
    );
  }
});

test("both modes sanitize final child environments without losing provider, proxy or CA settings", async (t) => {
  for (const mode of ["standalone", "electron"]) {
    const f = await fixture(t, mode);
    const inherited = {
      ELECTRON_RUN_AS_NODE: "wrong",
      electron_run_as_node: "wrong",
      ELECTRON_NO_ASAR: "1",
      Electron_No_Asar: "1",
      NODE_OPTIONS: "--import=/untrusted/preload.mjs",
      node_options: "--require=evil",
      NODE_PATH: "/untrusted/modules",
      NODE_EXTRA_CA_CERTS: "/custom/trust.pem",
      HTTPS_PROXY: "http://proxy.invalid",
      DEEPSEEK_API_KEY: "synthetic-key",
    };
    const env = f.backendRuntimeEnvironment(inherited);
    assert.deepEqual(env, {
      NODE_EXTRA_CA_CERTS: inherited.NODE_EXTRA_CA_CERTS,
      HTTPS_PROXY: inherited.HTTPS_PROXY,
      DEEPSEEK_API_KEY: inherited.DEEPSEEK_API_KEY,
      ...(mode === "electron" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    });
    assert.equal(inherited.NODE_OPTIONS, "--import=/untrusted/preload.mjs");
  }
});

test("source choice drives real staging transitions with no standalone acquisition in Electron mode", async (t) => {
  const standalone = await fixture(t, "standalone");
  bundle(standalone);
  const resources = await standalone.stageBackendRuntime(
    standalone.root,
    target,
    "Covel",
  );
  assert.equal(standalone.stageCalls.length, 1);
  assert.equal(
    await standalone.verifyBackendRuntime(resources, target),
    path.join(resources, "node/node"),
  );

  const electron = await fixture(t, "electron", { root: standalone.root });
  // A manifest-only change must not bless the old standalone bundle/resources.
  await assert.rejects(
    electron.stageBackendRuntime(electron.root, target),
    /Stale desktop runtime bundle/,
  );
  await assert.rejects(
    () => electron.verifyBackendRuntime(resources, target),
    /selection mismatch/,
  );
  bundle(electron);
  await electron.stageBackendRuntime(electron.root, target, "Covel");
  assert.equal(fs.existsSync(path.join(resources, "node")), false);
  assert.equal(electron.stageCalls.length, 0);
  await assert.rejects(
    () => standalone.verifyBackendRuntime(resources, target),
    /selection mismatch/,
  );
  const executable = electronFile(electron);
  const options = {
    ...target,
    electronExecutable: executable,
    electronVersions: eligible,
  };
  assert.equal(
    await electron.verifyBackendRuntime(resources, options),
    executable,
  );
  await assert.rejects(
    () =>
      electron.verifyBackendRuntime(resources, {
        ...options,
        electronVersions: { ...eligible, node: "24.22.0" },
      }),
    /Unsafe or unsupported/,
  );
  fs.mkdirSync(path.join(resources, "node"));
  await assert.rejects(
    () => electron.verifyBackendRuntime(resources, options),
    /Unexpected standalone Node resource/,
  );
  fs.rmSync(path.join(resources, "node"), { recursive: true });
  if (process.platform !== "win32") {
    fs.symlinkSync(
      path.join(resources, "absent"),
      path.join(resources, "node"),
    );
    await assert.rejects(
      () => electron.verifyBackendRuntime(resources, options),
      /Unexpected standalone Node resource/,
    );
    fs.unlinkSync(path.join(resources, "node"));
  }

  // The reverse transition also requires a new bundle and the pinned resource.
  await assert.rejects(
    standalone.stageBackendRuntime(standalone.root, target),
    /Stale desktop runtime bundle/,
  );
  bundle(standalone);
  await standalone.stageBackendRuntime(standalone.root, target, "Covel");
  assert.equal(
    await standalone.verifyBackendRuntime(resources, target),
    path.join(resources, "node/node"),
  );
});

test("both modes enforce all four targets and reject wrong metadata, missing resources and stale main bytes", async (t) => {
  for (const mode of ["standalone", "electron"]) {
    const f = await fixture(t, mode);
    bundle(f);
    for (const key of Object.keys(sourceManifest.targets)) {
      const [platform, arch] = key.split("-");
      const selected = { platform, arch };
      const resources = await f.stageBackendRuntime(f.root, selected, "Covel");
      assert.equal(
        path.basename(resources),
        `${platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux"}-${arch}`,
      );
      assert.doesNotThrow(() =>
        f.verifyRuntimeSelection(
          path.join(resources, "runtime-selection.json"),
          selected,
        ),
      );
      assert.throws(
        () =>
          f.verifyRuntimeSelection(
            path.join(resources, "runtime-selection.json"),
            { ...selected, arch: "wrong" },
          ),
        /Unsupported/,
      );
    }
    for (const selected of [
      { platform: "darwin", arch: "x64" },
      { platform: "win32", arch: "arm64" },
      { platform: "freebsd", arch: "x64" },
    ]) {
      await assert.rejects(
        f.stageBackendRuntime(f.root, selected),
        /Unsupported Node runtime target/,
      );
    }
    const resources = f.backendRuntimeStagingDirectory(f.root, target);
    const file = path.join(resources, "runtime-selection.json");
    const original = fs.readFileSync(file, "utf8");
    for (const patch of [
      { mode: mode === "electron" ? "standalone" : "electron" },
      { selection: "0".repeat(64) },
      { platform: "darwin" },
      { mainSha256: "bad" },
    ]) {
      fs.writeFileSync(
        file,
        JSON.stringify({ ...JSON.parse(original), ...patch }),
      );
      await assert.rejects(
        () => f.verifyBackendRuntime(resources, target),
        /selection mismatch/,
      );
    }
    fs.writeFileSync(file, original);
    fs.writeFileSync(path.join(f.root, "dist/main.mjs"), "stale dev bundle");
    assert.throws(
      () => f.verifyRuntimeBundleSelection(f.root),
      /Stale desktop runtime bundle/,
    );
    await assert.rejects(
      () =>
        f.verifyBackendRuntime(resources, {
          ...target,
          mainFile: path.join(f.root, "dist/main.mjs"),
        }),
      /SHA256 mismatch/,
    );
    fs.unlinkSync(file);
    await assert.rejects(
      () => f.verifyBackendRuntime(resources, target),
      /ENOENT/,
    );
  }
});

test("Electron fuse refusal happens before any version probe, including unknown/missing wires and multiple slices", async (t) => {
  const f = await fixture(t, "electron", { probeVersions: eligible });
  const executable = electronFile(f);
  delete globalThis.__runtimeProbe;
  for (const contents of [
    Buffer.from("no fuse"),
    fuseWire(48),
    fuseWire(114),
    fuseWire(49, 2),
    Buffer.concat([fuseWire(), fuseWire(48)]),
  ]) {
    fs.writeFileSync(executable, contents);
    await assert.rejects(
      () => f.probeBackendRuntime(executable, target),
      /RunAsNode fuse/,
    );
    assert.equal(globalThis.__runtimeProbe, undefined);
  }
  // Exercise a sentinel spanning a read boundary and the macOS framework path.
  fs.writeFileSync(
    executable,
    Buffer.concat([Buffer.alloc(128 * 1024 - 10), fuseWire()]),
  );
  assert.deepEqual(await f.probeBackendRuntime(executable, target), eligible);
  assert.equal(globalThis.__runtimeProbe.executable, executable);
  await f.assertElectronRunAsNodeCapability(
    electronFile(f, "darwin"),
    "darwin",
  );
  delete globalThis.__runtimeProbe;
});

test("version probing waits for the complete asynchronous fuse scan on every launch", async (t) => {
  const f = await fixture(t, "electron", { probeVersions: eligible });
  const executable = electronFile(f);
  const contents = Buffer.concat([Buffer.alloc(8 * 1024 * 1024), fuseWire()]);
  fs.writeFileSync(executable, contents);
  delete globalThis.__runtimeProbe;
  const checking = f.probeBackendRuntime(executable, target);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globalThis.__runtimeProbe, undefined);
  assert.deepEqual(await checking, eligible);
  assert.equal(globalThis.__runtimeProbe.executable, executable);
  delete globalThis.__runtimeProbe;
  // A later disabled slice must block the probe even after a successful launch.
  fs.appendFileSync(executable, fuseWire(48));
  await assert.rejects(
    f.probeBackendRuntime(executable, target),
    /RunAsNode fuse/,
  );
  assert.equal(globalThis.__runtimeProbe, undefined);
  fs.unlinkSync(executable);
  fs.writeFileSync(executable, contents);
  assert.deepEqual(await f.probeBackendRuntime(executable, target), eligible);
  delete globalThis.__runtimeProbe;
});

test("probes use the selected executable, sanitized environment and actual reported versions", async (t) => {
  const f = await fixture(t, "electron", { probeVersions: eligible });
  const executable = electronFile(f);
  assert.deepEqual(
    await f.probeBackendRuntime(executable, target, {
      NODE_OPTIONS: "--import=evil",
      ELECTRON_RUN_AS_NODE: "0",
      ELECTRON_NO_ASAR: "1",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
    }),
    eligible,
  );
  assert.equal(globalThis.__runtimeProbe.executable, executable);
  assert.deepEqual(globalThis.__runtimeProbe.options.env, {
    ELECTRON_RUN_AS_NODE: "1",
    NODE_EXTRA_CA_CERTS: "/ca.pem",
  });
  const old = await fixture(t, "electron", {
    probeVersions: { ...eligible, node: "24.22.0" },
  });
  await assert.rejects(
    () => old.probeBackendRuntime(electronFile(old), target),
    /Unsafe or unsupported/,
  );
  await assert.rejects(
    () => f.probeBackendRuntime(executable, { ...target, arch: "arm64" }),
    /target mismatch/,
  );
  delete globalThis.__runtimeProbe;
});

test("packaged executable resolution remains inside each actual target package", async (t) => {
  const f = await fixture(t, "electron");
  bundle(f);
  for (const selected of [
    { platform: "darwin", arch: "arm64" },
    { platform: "win32", arch: "x64" },
    target,
  ]) {
    const resources = await f.stageBackendRuntime(
      f.root,
      selected,
      selected.platform === "linux" ? "@coveldesktop" : "Covel",
    );
    const expected =
      selected.platform === "darwin"
        ? path.resolve(resources, "../MacOS/Covel")
        : path.resolve(
            resources,
            selected.platform === "win32" ? "../Covel.exe" : "../@coveldesktop",
          );
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.writeFileSync(expected, "synthetic packaged executable");
    assert.equal(f.packagedElectronExecutable(resources, selected), expected);
    fs.unlinkSync(expected);
    assert.throws(
      () => f.packagedElectronExecutable(resources, selected),
      /ENOENT/,
    );
    const metadata = path.join(resources, "runtime-selection.json");
    const value = JSON.parse(fs.readFileSync(metadata, "utf8"));
    fs.writeFileSync(
      metadata,
      JSON.stringify({ ...value, executableName: "../../host-node" }),
    );
    assert.throws(
      () => f.packagedElectronExecutable(resources, selected),
      /invalid packaged Electron/,
    );
  }
});

test("installed Electron is checked by actual embedded versions without a backend or safety bypass", async (t) => {
  const executable = ensureElectronBinary();
  const f = await fixture(t, "electron");
  await f.assertElectronRunAsNodeCapability(executable, process.platform);
  const versions = JSON.parse(
    execFileSync(
      executable,
      [
        "-e",
        "console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron}))",
      ],
      {
        env: f.backendRuntimeEnvironment(process.env),
        encoding: "utf8",
        timeout: 10_000,
      },
    ),
  );
  t.diagnostic(
    `Actual installed Electron ${versions.electron}, embedded Node ${versions.node}`,
  );
  let safe = false;
  try {
    f.assertSafeElectronVersions(versions);
    safe = true;
  } catch {
    /* expected for the current unpatched Electron */
  }
  const selected = { platform: process.platform, arch: process.arch };
  if (safe)
    await assert.doesNotReject(() =>
      f.probeBackendRuntime(executable, selected),
    );
  else
    await assert.rejects(
      () => f.probeBackendRuntime(executable, selected),
      /Unsafe or unsupported/,
    );
});

test("missing or unknown build choices never select a default or host runtime", async (t) => {
  for (const mode of [undefined, "system", "auto"]) {
    await assert.rejects(
      fixture(t, mode),
      /Invalid desktop backend runtime mode/,
    );
  }
});

test("selection metadata is mandatory, regular and bound to the exact main bytes", async (t) => {
  const f = await fixture(t, "standalone");
  bundle(f);
  const resources = await f.stageBackendRuntime(f.root, target);
  const selection = path.join(resources, "runtime-selection.json");
  const options = { ...target, mainFile: path.join(f.root, "dist/main.mjs") };
  assert.equal(
    await f.verifyBackendRuntime(resources, options),
    path.join(resources, "node/node"),
  );
  fs.writeFileSync(path.join(resources, "node/node"), "corrupt replacement");
  await assert.rejects(
    () => f.verifyBackendRuntime(resources, options),
    /SHA256 mismatch/,
  );
  if (process.platform !== "win32") {
    fs.renameSync(selection, `${selection}.original`);
    fs.symlinkSync(`${selection}.original`, selection);
    await assert.rejects(
      () => f.verifyBackendRuntime(resources, options),
      /regular file/,
    );
  }
});

test("native Node loads the build and packaging runtime entries without esbuild resolution", () => {
  const runtimeUrl = new URL("./backend-runtime.mjs", import.meta.url).href;
  const hookUrl = new URL("./before-pack.mjs", import.meta.url).href;
  const stdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const runtime = await import(${JSON.stringify(runtimeUrl)});
       const hook = await import(${JSON.stringify(hookUrl)});
       console.log(JSON.stringify({ mode: runtime.BACKEND_RUNTIME_MODE, hook: typeof hook.default }));`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    mode: sourceManifest.mode,
    hook: "function",
  });
});
