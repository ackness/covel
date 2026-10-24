import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import desktopPackage from "../package.json" with { type: "json" };
// Packaging scripts also load this module through native Node type stripping.
import { assertDesktopTarget, verifyRuntimeFile } from "./runtime-integrity.ts";

export const BACKEND_RUNTIME_MODE = "electron";
export const ELECTRON_VERSION = desktopPackage.devDependencies.electron;
// Electron's Node version is an identity check, not a claim that every upstream
// Node fix is included. Review Electron backports and Chromium dependencies on upgrade.
export const EMBEDDED_NODE_VERSION = "24.22.0";
export const RUNTIME_SELECTION_ID = createHash("sha256")
  .update(`desktop-electron-v1:${ELECTRON_VERSION}:${EMBEDDED_NODE_VERSION}`)
  .digest("hex");

interface RuntimeTarget {
  platform?: string;
  arch?: string;
}

interface ElectronVersions {
  node?: string;
  electron?: string;
}

/** Only the reviewed, pinned Electron/Node pair may execute the backend. */
export function assertSafeElectronVersions(versions: ElectronVersions): void {
  if (
    versions.electron !== ELECTRON_VERSION ||
    versions.node !== EMBEDDED_NODE_VERSION
  ) {
    throw new Error(
      `Unexpected Electron backend runtime: Electron ${versions.electron ?? "missing"}, Node ${versions.node ?? "missing"}. Requires Electron ${ELECTRON_VERSION} with embedded Node ${EMBEDDED_NODE_VERSION}; no fallback is permitted.`,
    );
  }
}

/**
 * Read Electron's V1 fuse wire without starting it. With RunAsNode disabled,
 * a version probe would otherwise launch another GUI. Check every slice.
 * Wire format: https://github.com/electron/fuses (sentinel, version, size, states).
 */
export async function assertElectronRunAsNodeCapability(
  executable: string,
  platform: string,
): Promise<void> {
  const binary =
    platform === "darwin"
      ? path.resolve(
          path.dirname(executable),
          "../Frameworks/Electron Framework.framework/Electron Framework",
        )
      : executable;
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  const buffer = Buffer.allocUnsafe(128 * 1024 + sentinel.length - 1);
  const header = Buffer.allocUnsafe(3);
  const file = await fs.promises.open(binary, "r");
  let found = false;
  try {
    const size = (await file.stat()).size;
    let position = 0;
    let retained = 0;
    while (position < size) {
      const { bytesRead: count } = await file.read(
        buffer,
        retained,
        128 * 1024,
        position,
      );
      if (count === 0) break;
      const end = retained + count;
      for (
        let index = buffer.indexOf(sentinel);
        index >= 0 && index + sentinel.length <= end;
        index = buffer.indexOf(sentinel, index + 1)
      ) {
        const offset = position - retained + index + sentinel.length;
        const { bytesRead: bytes } = await file.read(header, 0, 3, offset);
        if (
          bytes !== 3 ||
          header[0] !== 1 ||
          header[1]! < 1 ||
          offset + 2 + header[1]! > size ||
          header[2] !== 49
        ) {
          throw new Error(
            `Electron RunAsNode fuse is disabled, missing, or unsupported: ${binary}`,
          );
        }
        found = true;
      }
      retained = Math.min(sentinel.length - 1, end);
      buffer.copy(buffer, 0, end - retained, end);
      position += count;
    }
    if (!found)
      throw new Error(`Electron RunAsNode fuse is missing: ${binary}`);
  } finally {
    await file.close();
  }
}

/** Do not inherit a shell/.env preload, search-path override or Electron mode. */
export function backendRuntimeEnvironment(
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  // Environment names are case insensitive on Windows. Strip all spellings
  // there too, before installing the one authoritative Electron value.
  for (const key of Object.keys(env)) {
    switch (key.toUpperCase()) {
      case "ELECTRON_RUN_AS_NODE":
      case "ELECTRON_NO_ASAR":
      case "NODE_OPTIONS":
      case "NODE_PATH":
        delete env[key];
    }
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

export function verifyRuntimeSelection(
  file: string,
  { platform = process.platform, arch = process.arch }: RuntimeTarget = {},
): { mainSha256: string; preloadSha256: string; executableName?: unknown } {
  assertDesktopTarget(platform, arch);
  if (!fs.lstatSync(file).isFile()) {
    throw new Error(
      `Backend runtime selection must be a regular file: ${file}`,
    );
  }
  const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    metadata?.mode !== BACKEND_RUNTIME_MODE ||
    metadata?.selection !== RUNTIME_SELECTION_ID ||
    metadata?.platform !== platform ||
    metadata?.arch !== arch ||
    typeof metadata?.mainSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.mainSha256) ||
    typeof metadata?.preloadSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.preloadSha256)
  ) {
    throw new Error(
      `Backend runtime selection mismatch: ${file}. Rebuild/reinstall the complete desktop application.`,
    );
  }
  return metadata;
}

export async function verifyBackendRuntime(
  resources: string,
  {
    platform = process.platform,
    arch = process.arch,
    electronExecutable,
    electronVersions,
    mainFile,
    preloadFile = mainFile && path.join(path.dirname(mainFile), "preload.mjs"),
  }: RuntimeTarget & {
    electronExecutable?: string;
    electronVersions?: ElectronVersions | (() => ElectronVersions);
    mainFile?: string;
    preloadFile?: string;
  } = {},
): Promise<string> {
  const selection = verifyRuntimeSelection(
    path.join(resources, "runtime-selection.json"),
    { platform, arch },
  );
  if (mainFile) await verifyRuntimeFile(mainFile, selection.mainSha256);
  if (preloadFile)
    await verifyRuntimeFile(preloadFile, selection.preloadSha256);
  const standalone = path.join(resources, "node");
  // lstat rejects even a dangling link. A stale standalone resource must not
  // survive a switch-back or become an implicit fallback.
  let standaloneExists = false;
  try {
    fs.lstatSync(standalone);
    standaloneExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (standaloneExists) {
    throw new Error(
      `Unexpected standalone Node resource in Electron mode: ${standalone}`,
    );
  }
  if (!electronExecutable || !path.isAbsolute(electronExecutable)) {
    throw new Error(
      "The exact Electron executable is required for the backend runtime",
    );
  }
  await assertElectronRunAsNodeCapability(electronExecutable, platform);
  // Packaging probes may execute only after the resource and fuse checks pass.
  assertSafeElectronVersions(
    typeof electronVersions === "function"
      ? electronVersions()
      : (electronVersions ?? {}),
  );
  return electronExecutable;
}
