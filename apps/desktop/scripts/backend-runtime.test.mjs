import { createHash } from "node:crypto";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { verifyRuntimeFile } from "../src/runtime-integrity.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { ensureElectronBinary } from "./ensure-electron.mjs";

const scripts = fileURLToPath(new URL(".", import.meta.url));
const target = { platform: "linux", arch: "x64" };
const eligible = { node: "24.22.0", electron: "45.0.0", ...target };
const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const fuseWire = (state = 49, version = 1) =>
  Buffer.concat([sentinel, Buffer.from([version, 1, state])]);

async function fixture(t, { probeVersions } = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "covel-electron-runtime-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "runtime.mjs");
  await build({
    stdin: {
      contents: `export * from "./backend-runtime.mjs";
        export { RUNTIME_SELECTION_ID, assertSafeElectronVersions, assertElectronRunAsNodeCapability, verifyRuntimeSelection } from "../src/backend-runtime.ts";`,
      resolveDir: scripts,
      sourcefile: "runtime-fixture.mjs",
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: probeVersions
      ? [
          {
            name: "version-probe",
            setup(builder) {
              builder.onResolve({ filter: /^node:child_process$/ }, () => ({
                path: "probe",
                namespace: "inputs",
              }));
              builder.onLoad({ filter: /.*/, namespace: "inputs" }, () => ({
                contents: `export function execFileSync(executable, args, options) {
            globalThis.__runtimeProbe = { executable, args, options };
            return JSON.stringify(${JSON.stringify(probeVersions)});
          }`,
              }));
            },
          },
        ]
      : [],
  });
  const runtime = await import(pathToFileURL(output).href);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  return { ...runtime, root };
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

test("only the reviewed Electron and embedded Node pair is accepted", async (t) => {
  const f = await fixture(t);
  assert.doesNotThrow(() => f.assertSafeElectronVersions(eligible));
  for (const patch of [
    { node: undefined },
    { node: "24.22.1" },
    { node: "26.12.1" },
    { electron: "44.9.3" },
    { electron: "45.0.1" },
    { electron: "45.0.0-beta.1" },
    { electron: undefined },
  ]) {
    assert.throws(
      () => f.assertSafeElectronVersions({ ...eligible, ...patch }),
      /Unexpected Electron backend runtime/,
    );
  }
});

test("child processes sanitize final child environments without losing provider, proxy or CA settings", async (t) => {
  {
    const f = await fixture(t);
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
      ELECTRON_RUN_AS_NODE: "1",
    });
    assert.equal(inherited.NODE_OPTIONS, "--import=/untrusted/preload.mjs");
  }
});

test("staging removes obsolete Node resources and verifies the exact Electron executable", async (t) => {
  const f = await fixture(t);
  bundle(f);
  const resources = await f.stageBackendRuntime(f.root, target, "Covel");
  fs.mkdirSync(path.join(resources, "node"));
  fs.writeFileSync(path.join(resources, "node/node"), "old runtime");
  await f.stageBackendRuntime(f.root, target, "Covel");
  assert.equal(fs.existsSync(path.join(resources, "node")), false);
  const executable = electronFile(f);
  const options = {
    ...target,
    electronExecutable: executable,
    electronVersions: eligible,
  };
  assert.equal(await f.verifyBackendRuntime(resources, options), executable);
  await assert.rejects(
    () =>
      f.verifyBackendRuntime(resources, {
        ...options,
        electronExecutable: "node",
      }),
    /exact Electron executable/,
  );
  fs.mkdirSync(path.join(resources, "node"));
  await assert.rejects(
    () => f.verifyBackendRuntime(resources, options),
    /Unexpected standalone Node resource/,
  );
  fs.rmSync(path.join(resources, "node"), { recursive: true });
  if (process.platform !== "win32") {
    fs.symlinkSync(
      path.join(resources, "absent"),
      path.join(resources, "node"),
    );
    await assert.rejects(
      () => f.verifyBackendRuntime(resources, options),
      /Unexpected standalone Node resource/,
    );
  }
});

test("packaging enforces all four targets and reject wrong metadata, missing resources and stale main bytes", async (t) => {
  {
    const f = await fixture(t);
    bundle(f);
    for (const key of [
      "darwin-arm64",
      "win32-x64",
      "linux-x64",
      "linux-arm64",
    ]) {
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
        /Unsupported desktop runtime target/,
      );
    }
    const resources = f.backendRuntimeStagingDirectory(f.root, target);
    const file = path.join(resources, "runtime-selection.json");
    const original = fs.readFileSync(file, "utf8");
    for (const patch of [
      { mode: "standalone" },
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
  const f = await fixture(t, { probeVersions: eligible });
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
  const f = await fixture(t, { probeVersions: eligible });
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

test("combined resource preflight scans once per call and blocks probes after corruption", async (t) => {
  const f = await fixture(t, { probeVersions: eligible });
  bundle(f);
  const resources = await f.stageBackendRuntime(f.root, target, "Covel");
  const executable = electronFile(f);
  const open = fs.promises.open;
  let scans = 0;
  t.mock.method(fs.promises, "open", async (file, ...args) => {
    if (file === executable) scans++;
    return open.call(fs.promises, file, ...args);
  });
  for (let expected = 1; expected <= 2; expected++) {
    assert.deepEqual(
      await f.verifyAndProbeBackendRuntime(resources, executable, target, {
        NODE_OPTIONS: "--import=evil",
        NODE_EXTRA_CA_CERTS: "/ca.pem",
      }),
      eligible,
    );
    assert.equal(scans, expected, "each preflight scans once without caching");
    assert.deepEqual(globalThis.__runtimeProbe.options.env, {
      ELECTRON_RUN_AS_NODE: "1",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
    });
  }
  delete globalThis.__runtimeProbe;
  fs.appendFileSync(executable, fuseWire(48));
  await assert.rejects(
    f.verifyAndProbeBackendRuntime(resources, executable, target),
    /RunAsNode fuse/,
  );
  assert.equal(scans, 3);
  assert.equal(globalThis.__runtimeProbe, undefined);
  fs.writeFileSync(executable, fuseWire());
  fs.mkdirSync(path.join(resources, "node"));
  await assert.rejects(
    f.verifyAndProbeBackendRuntime(resources, executable, target),
    /Unexpected standalone Node resource/,
  );
  assert.equal(scans, 3, "invalid resources fail before scanning or probing");
  assert.equal(globalThis.__runtimeProbe, undefined);

  const wrong = await fixture(t, {
    probeVersions: { ...eligible, node: "24.21.0" },
  });
  bundle(wrong);
  const wrongResources = await wrong.stageBackendRuntime(
    wrong.root,
    target,
    "Covel",
  );
  await assert.rejects(
    wrong.verifyAndProbeBackendRuntime(
      wrongResources,
      electronFile(wrong),
      target,
    ),
    /Unexpected Electron backend runtime/,
  );
  delete globalThis.__runtimeProbe;
});

test("probes use the selected executable, sanitized environment and actual reported versions", async (t) => {
  const f = await fixture(t, { probeVersions: eligible });
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
  const old = await fixture(t, {
    probeVersions: { ...eligible, node: "24.21.0" },
  });
  await assert.rejects(
    () => old.probeBackendRuntime(electronFile(old), target),
    /Unexpected Electron backend runtime/,
  );
  await assert.rejects(
    () => f.probeBackendRuntime(executable, { ...target, arch: "arm64" }),
    /target mismatch/,
  );
  delete globalThis.__runtimeProbe;
});

test("packaged executable resolution remains inside each actual target package", async (t) => {
  const f = await fixture(t);
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
  const f = await fixture(t);
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
  assert.doesNotThrow(() => f.assertSafeElectronVersions(versions));
  await assert.doesNotReject(() =>
    f.probeBackendRuntime(executable, {
      platform: process.platform,
      arch: process.arch,
    }),
  );
});

test("selection metadata is mandatory, regular and bound to the exact main bytes", async (t) => {
  const f = await fixture(t);
  bundle(f);
  const resources = await f.stageBackendRuntime(f.root, target);
  const selection = path.join(resources, "runtime-selection.json");
  const executable = electronFile(f);
  const options = {
    ...target,
    mainFile: path.join(f.root, "dist/main.mjs"),
    electronExecutable: executable,
    electronVersions: eligible,
  };
  assert.equal(await f.verifyBackendRuntime(resources, options), executable);
  fs.writeFileSync(options.mainFile, "corrupt replacement");
  await assert.rejects(
    () => f.verifyBackendRuntime(resources, options),
    /SHA256 mismatch/,
  );
  bundle(f);
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
    mode: "electron",
    hook: "function",
  });
});

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("hash verification yields between reads, rejects corruption and reopens every time", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-async-hash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "binary");
  const contents = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  const expected = digest(contents);
  fs.writeFileSync(file, contents);
  let completed = false;
  const checking = verifyRuntimeFile(file, expected).then(() => {
    completed = true;
  });
  await nextImmediate();
  assert.equal(completed, false, "the event loop runs during binary hashing");
  await checking;
  assert.equal(completed, true);
  fs.writeFileSync(file, "corrupt replacement");
  await assert.rejects(verifyRuntimeFile(file, expected), /SHA256 mismatch/);
  // A failed scan must release its file handle and never cache its result.
  fs.unlinkSync(file);
  fs.writeFileSync(file, contents);
  await verifyRuntimeFile(file, expected);
  fs.unlinkSync(file);
  await assert.rejects(verifyRuntimeFile(file, expected), /ENOENT/);
});
