import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import manifest from "../node-runtime.json" with { type: "json" };

export const NODE_VERSION = manifest.version;
export const NODE_LICENSE_SHA256 = manifest.license.sha256;

interface NodeRuntimeArtifact {
  file: string;
  sha256: string;
  member?: string;
  binarySha256: string;
}

interface NodeRuntimeOptions {
  platform?: string;
  arch?: string;
}

export function getNodeRuntimeTarget(platform: string, arch: string) {
  const key = `${platform}-${arch}`;
  const targets: Record<string, NodeRuntimeArtifact> = manifest.targets;
  const artifact = Object.hasOwn(targets, key) ? targets[key] : undefined;
  if (!artifact) {
    throw new Error(`Unsupported Node runtime target: ${key}`);
  }
  const binary = platform === "win32" ? "node.exe" : "node";
  const root = `node-v${NODE_VERSION}-${key}`;
  const expectedFile =
    platform === "win32" ? "win-x64/node.exe" : `${root}.tar.gz`;
  const expectedMember = platform === "win32" ? undefined : `${root}/bin/node`;
  if (
    !/^\d+\.\d+\.\d+$/.test(NODE_VERSION) ||
    artifact.file !== expectedFile ||
    artifact.member !== expectedMember ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !/^[a-f0-9]{64}$/.test(artifact.binarySha256) ||
    !/^[a-f0-9]{64}$/.test(NODE_LICENSE_SHA256)
  ) {
    throw new Error(`Invalid Node runtime manifest for ${key}`);
  }
  return { ...artifact, key, binary };
}

function requireRegular(file: string): void {
  if (!fs.lstatSync(file).isFile()) {
    throw new Error(
      `Node runtime file must be regular (not a symlink): ${file}`,
    );
  }
}

export async function verifyNodeRuntimeFile(
  file: string,
  expected: string,
): Promise<void> {
  requireRegular(file);
  const hash = createHash("sha256");
  // Bounded asynchronous reads keep the desktop event loop responsive. Use the
  // fs stream API so Electron also reads the actual main entry inside app.asar.
  for await (const chunk of fs.createReadStream(file, {
    highWaterMark: 128 * 1024,
  })) {
    hash.update(chunk);
  }
  if (hash.digest("hex") !== expected) {
    throw new Error(`Node runtime SHA256 mismatch: ${file}`);
  }
}

/** Fresh, offline verification against pins bundled into the application. */
export async function verifyNodeRuntime(
  directory: string,
  { platform = process.platform, arch = process.arch }: NodeRuntimeOptions = {},
): Promise<string> {
  const target = getNodeRuntimeTarget(platform, arch);
  const resolved = path.resolve(directory);
  if (!fs.lstatSync(resolved).isDirectory()) {
    throw new Error(
      `Node runtime directory must be a real directory: ${resolved}`,
    );
  }
  const metadataFile = path.join(resolved, "runtime.json");
  requireRegular(metadataFile);
  const metadata: unknown = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`Invalid Node runtime metadata: ${resolved}`);
  }
  const fields = metadata as Record<string, unknown>;
  if (
    fields.version !== NODE_VERSION ||
    fields.platform !== platform ||
    fields.arch !== arch ||
    fields.binary !== target.binary ||
    fields.binarySha256 !== target.binarySha256
  ) {
    throw new Error(
      `Node runtime metadata mismatch for ${target.key}: ${resolved}`,
    );
  }
  const binary = path.join(resolved, target.binary);
  await verifyNodeRuntimeFile(binary, target.binarySha256);
  await verifyNodeRuntimeFile(
    path.join(resolved, "LICENSE"),
    NODE_LICENSE_SHA256,
  );
  if (platform !== "win32" && process.platform !== "win32") {
    fs.accessSync(binary, fs.constants.X_OK);
  }
  return binary;
}
