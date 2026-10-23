import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  BACKEND_RUNTIME_MODE,
  RUNTIME_SELECTION_ID,
  assertElectronRunAsNodeCapability,
  assertSafeElectronVersions,
  backendRuntimeEnvironment,
  verifyBackendRuntime,
  verifyRuntimeSelection,
} from "../src/backend-runtime.ts";
import { assertDesktopTarget } from "../src/runtime-integrity.ts";

export {
  BACKEND_RUNTIME_MODE,
  backendRuntimeEnvironment,
  verifyBackendRuntime,
  verifyRuntimeSelection,
};

const hashFile = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Called only after bundling; binds the chosen manifest to these main bytes. */
export function writeRuntimeBundleSelection(desktopRoot) {
  const selection = {
    mode: BACKEND_RUNTIME_MODE,
    selection: RUNTIME_SELECTION_ID,
    mainSha256: hashFile(path.join(desktopRoot, "dist/main.mjs")),
  };
  fs.writeFileSync(
    path.join(desktopRoot, "dist/runtime-selection.json"),
    `${JSON.stringify(selection, null, 2)}\n`,
  );
}

export function verifyRuntimeBundleSelection(desktopRoot) {
  const file = path.join(desktopRoot, "dist/runtime-selection.json");
  if (!fs.lstatSync(file).isFile())
    throw new Error(`Invalid runtime bundle selection: ${file}`);
  const selection = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    selection?.mode !== BACKEND_RUNTIME_MODE ||
    selection?.selection !== RUNTIME_SELECTION_ID ||
    selection?.mainSha256 !== hashFile(path.join(desktopRoot, "dist/main.mjs"))
  ) {
    throw new Error(
      "Stale desktop runtime bundle/manifest: rebuild desktop before packaging",
    );
  }
  return selection;
}

export function backendRuntimeStagingDirectory(
  desktopRoot,
  { platform, arch },
) {
  assertDesktopTarget(platform, arch);
  const os = { darwin: "mac", win32: "win", linux: "linux" }[platform];
  return path.join(desktopRoot, "staging", "backend-runtime", `${os}-${arch}`);
}

export async function stageBackendRuntime(desktopRoot, target, executableName) {
  const selection = verifyRuntimeBundleSelection(desktopRoot);
  const resources = backendRuntimeStagingDirectory(desktopRoot, target);
  // Never carry obsolete runtime resources into a fresh package.
  fs.rmSync(resources, { recursive: true, force: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(
    path.join(resources, "runtime-selection.json"),
    `${JSON.stringify({ ...selection, ...target, executableName }, null, 2)}\n`,
  );
  verifyRuntimeSelection(
    path.join(resources, "runtime-selection.json"),
    target,
  );
  return resources;
}

/** Probe only versions, never the server or a preload from the user's shell. */
export async function probeBackendRuntime(
  executable,
  target,
  inherited = process.env,
) {
  await assertElectronRunAsNodeCapability(executable, target.platform);
  const env = backendRuntimeEnvironment(inherited);
  const versions = JSON.parse(
    execFileSync(
      executable,
      [
        "--input-type=module",
        "-e",
        "console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,platform:process.platform,arch:process.arch}))",
      ],
      { env, encoding: "utf8", timeout: 10_000, windowsHide: true },
    ),
  );
  if (versions.platform !== target.platform || versions.arch !== target.arch) {
    throw new Error(
      `Backend runtime target mismatch: ${JSON.stringify(versions)}`,
    );
  }
  assertSafeElectronVersions(versions);
  return versions;
}

/** Resolve inside this package, never from PATH or a smoke/runtime override. */
export function packagedElectronExecutable(resources, target) {
  const { executableName } = verifyRuntimeSelection(
    path.join(resources, "runtime-selection.json"),
    target,
  );
  if (
    typeof executableName !== "string" ||
    !executableName ||
    executableName === "." ||
    executableName === ".." ||
    /[/\\:]/.test(executableName)
  ) {
    throw new Error("Missing or invalid packaged Electron executable name");
  }
  const executable =
    target.platform === "darwin"
      ? path.join(resources, "..", "MacOS", executableName)
      : path.join(
          resources,
          "..",
          `${executableName}${target.platform === "win32" ? ".exe" : ""}`,
        );
  if (!fs.lstatSync(executable).isFile())
    throw new Error(`Missing packaged Electron executable: ${executable}`);
  return path.resolve(executable);
}
