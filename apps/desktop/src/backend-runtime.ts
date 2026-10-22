import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import manifest from "../node-runtime.json" with { type: "json" };
// Packaging scripts also load this module through native Node type stripping.
import {
  getNodeRuntimeTarget,
  verifyNodeRuntime,
  verifyNodeRuntimeFile,
} from "./node-runtime.ts";

function configuredMode(): "standalone" | "electron" {
  if (manifest.mode !== "standalone" && manifest.mode !== "electron") {
    throw new Error(`Invalid desktop backend runtime mode: ${manifest.mode}`);
  }
  return manifest.mode;
}

// esbuild embeds this manifest in main.mjs. Resource metadata is a consistency
// check, never a runtime selector. A changed choice requires a fresh bundle.
export const BACKEND_RUNTIME_MODE = configuredMode();
export const RUNTIME_SELECTION_ID = createHash("sha256")
  .update(`desktop-backend-v1:${JSON.stringify(manifest)}`)
  .digest("hex");

interface RuntimeTarget {
  platform?: string;
  arch?: string;
}

interface ElectronVersions {
  node?: string;
  electron?: string;
}

function stableVersion(version: string | undefined): number[] | undefined {
  if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    return undefined;
  }
  const parts = version.split(".").map(Number);
  return parts.every(Number.isSafeInteger) && parts.join(".") === version
    ? parts
    : undefined;
}

/** Only explicitly supported, patched stable Node release lines are eligible. */
export function assertSafeElectronVersions(versions: ElectronVersions): void {
  const node = stableVersion(versions.node);
  const electron = stableVersion(versions.electron);
  const minimumMinor =
    node?.[0] === 24 ? 22 : node?.[0] === 26 ? 12 : undefined;
  if (
    !node ||
    !electron ||
    minimumMinor === undefined ||
    node[1]! < minimumMinor ||
    (node[1] === minimumMinor && node[2]! < 1)
  ) {
    throw new Error(
      `Unsafe or unsupported Electron backend runtime: Electron ${versions.electron ?? "missing"}, Node ${versions.node ?? "missing"}. Requires stable Electron with patched Node 24.22.1+ (24.x) or 26.12.1+ (26.x); no fallback is permitted.`,
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
  if (BACKEND_RUNTIME_MODE === "electron") env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

export function verifyRuntimeSelection(
  file: string,
  { platform = process.platform, arch = process.arch }: RuntimeTarget = {},
): { mainSha256: string; executableName?: unknown } {
  getNodeRuntimeTarget(platform, arch); // Preserve the existing supported matrix.
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
    !/^[a-f0-9]{64}$/.test(metadata.mainSha256)
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
  }: RuntimeTarget & {
    electronExecutable?: string;
    electronVersions?: ElectronVersions;
    mainFile?: string;
  } = {},
): Promise<string> {
  const selection = verifyRuntimeSelection(
    path.join(resources, "runtime-selection.json"),
    { platform, arch },
  );
  if (mainFile) await verifyNodeRuntimeFile(mainFile, selection.mainSha256);
  const standalone = path.join(resources, "node");
  if (BACKEND_RUNTIME_MODE === "standalone") {
    return verifyNodeRuntime(standalone, { platform, arch });
  }
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
  assertSafeElectronVersions(electronVersions ?? {});
  if (!electronExecutable || !path.isAbsolute(electronExecutable)) {
    throw new Error(
      "The exact Electron executable is required for the backend runtime",
    );
  }
  await assertElectronRunAsNodeCapability(electronExecutable, platform);
  return electronExecutable;
}
