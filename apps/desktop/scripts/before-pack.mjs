import fs from "node:fs";
import path from "node:path";
import { Arch } from "electron-builder";
import {
  probeBackendRuntime,
  stageBackendRuntime,
} from "./backend-runtime.mjs";
import { ensureElectronBinary } from "./ensure-electron.mjs";
import { assertDesktopTarget } from "../src/runtime-integrity.ts";

/**
 * Optional native packages must match the package target, not the build host.
 * Checking package.json alone would accept a pruned or incomplete install.
 */
export function verifyTargetNativePackages(
  serverDirectory,
  { platform, arch },
) {
  const modules = path.join(serverDirectory, "node_modules");
  const esbuildBinary = path.join(
    modules,
    "@esbuild",
    `${platform}-${arch}`,
    platform === "win32" ? "esbuild.exe" : "bin/esbuild",
  );
  // sqlite-vec's own loader uses "windows", whereas esbuild uses "win32".
  const vectorPlatform = platform === "win32" ? "windows" : platform;
  const vectorSuffix = { darwin: "dylib", win32: "dll", linux: "so" }[platform];
  const vectorBinary = path.join(
    modules,
    `sqlite-vec-${vectorPlatform}-${arch}`,
    `vec0.${vectorSuffix}`,
  );
  for (const binary of [esbuildBinary, vectorBinary]) {
    try {
      const stat = fs.statSync(binary);
      if (!stat.isFile() || stat.size === 0) {
        throw new Error("not a nonempty native binary");
      }
      if (binary === esbuildBinary && platform !== "win32") {
        fs.accessSync(binary, fs.constants.X_OK);
      }
    } catch (cause) {
      throw new Error(
        `Missing or unusable ${platform}-${arch} desktop native dependency: ${binary}. Install the target's optional dependencies and rebuild desktop staging before packaging.`,
        { cause },
      );
    }
  }
}

/** Runs once per electron-builder target, before extraResources are copied. */
export default async function beforePack(context) {
  const platform = context.electronPlatformName;
  const os = { darwin: "mac", win32: "win", linux: "linux" }[platform];
  const arch = Arch[context.arch];
  if (!os || !["x64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported desktop runtime target: ${platform}-${arch}`);
  }
  assertDesktopTarget(platform, arch);
  verifyTargetNativePackages(
    path.join(context.packager.projectDir, "staging", "server"),
    { platform, arch },
  );
  await probeBackendRuntime(ensureElectronBinary(), {
    platform: process.platform,
    arch: process.arch,
  });
  await stageBackendRuntime(
    context.packager.projectDir,
    { platform, arch },
    context.packager.executableName ?? context.packager.appInfo.productFilename,
  );
}
