import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  NODE_VERSION,
  NODE_LICENSE_SHA256,
  getNodeRuntimeTarget as targetInfo,
  verifyNodeRuntime,
  verifyNodeRuntimeFile as verifyHash,
} from "../src/node-runtime.ts";

export { verifyNodeRuntime };

const desktopDir = fileURLToPath(new URL("../", import.meta.url));
const licenseFile = path.join(desktopDir, "resources", "node-LICENSE.txt");
const maxDownloadBytes = 160 * 1024 * 1024;

function assertMiseVersion() {
  const mise = fs.readFileSync(
    new URL("../../../mise.toml", import.meta.url),
    "utf8",
  );
  const nodePin = /^node\s*=\s*"([^"]+)"\s*$/m.exec(mise)?.[1];
  if (nodePin !== NODE_VERSION) {
    throw new Error(
      `Node runtime manifest ${NODE_VERSION} does not match mise Node pin ${nodePin}`,
    );
  }
}

function entryExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// The upstream docker-node flow verifies SHASUMS256 before native tar extraction.
// Here those official hashes and extracted binary hashes are reviewed repository
// pins, so builds need neither a keyserver nor a mutable remote checksum file.
async function acquireArtifact(target) {
  const cache = path.join(
    desktopDir,
    "node_modules",
    ".cache",
    "covel-node-runtime",
    `v${NODE_VERSION}`,
    target.key,
  );
  fs.mkdirSync(cache, { recursive: true });
  const artifact = path.join(cache, path.basename(target.file));
  if (entryExists(artifact)) {
    await verifyHash(artifact, target.sha256);
    return artifact;
  }
  const temporary = fs.mkdtempSync(path.join(cache, ".download-"));
  let agent;
  try {
    // Use Node's per-agent environment proxy support without changing globals.
    agent = new https.Agent({ proxyEnv: process.env });
    const download = path.join(temporary, "artifact");
    const url = new URL(
      target.file,
      `https://nodejs.org/dist/v${NODE_VERSION}/`,
    );
    // Native HTTPS never follows redirects; every non-200 response is rejected.
    const signal = AbortSignal.timeout(120_000);
    const response = await new Promise((resolve, reject) => {
      const request = https.get(
        url,
        {
          agent,
          signal,
          headers: { "accept-encoding": "identity" },
        },
        resolve,
      );
      request.once("error", reject);
    });
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error(
        `Unexpected Node runtime download response: ${response.statusCode} ${url.href}`,
      );
    }
    const length = Number(response.headers["content-length"] ?? 0);
    if (!Number.isFinite(length) || length < 0 || length > maxDownloadBytes) {
      response.destroy();
      throw new Error("Node runtime download exceeds size limit");
    }
    let bytes = 0;
    const hash = createHash("sha256");
    const check = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxDownloadBytes) {
          callback(new Error("Node runtime download exceeds size limit"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      response,
      check,
      fs.createWriteStream(download, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (hash.digest("hex") !== target.sha256) {
      throw new Error(`Node runtime SHA256 mismatch: ${url.href}`);
    }
    fs.renameSync(download, artifact);
    return artifact;
  } finally {
    agent?.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** Build-time only: acquire a pinned artifact and atomically publish its runtime. */
export async function stageNodeRuntime(
  destination,
  { platform = process.platform, arch = process.arch } = {},
) {
  assertMiseVersion();
  const target = targetInfo(platform, arch);
  const resolved = path.resolve(destination);
  // Never bless or silently overwrite an incomplete/corrupt previous stage.
  if (entryExists(resolved))
    return verifyNodeRuntime(resolved, { platform, arch });
  await verifyHash(licenseFile, NODE_LICENSE_SHA256);
  const artifact = await acquireArtifact(target);
  // Recheck even newly downloaded/cache-restored bytes immediately before tar.
  await verifyHash(artifact, target.sha256);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = fs.mkdtempSync(
    path.join(path.dirname(resolved), ".node-runtime-"),
  );
  try {
    const staged = path.join(temporary, "staged");
    fs.mkdirSync(staged);
    let source = artifact;
    if (target.member) {
      const extracted = path.join(temporary, "extract");
      fs.mkdirSync(extracted);
      execFileSync(
        "tar",
        ["-xzf", artifact, "-C", extracted, "--", target.member],
        {
          timeout: 60_000,
          stdio: "pipe",
          windowsHide: true,
        },
      );
      source = path.join(extracted, ...target.member.split("/"));
    }
    await verifyHash(source, target.binarySha256);
    const binary = path.join(staged, target.binary);
    fs.copyFileSync(source, binary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(binary, 0o755);
    fs.copyFileSync(
      licenseFile,
      path.join(staged, "LICENSE"),
      fs.constants.COPYFILE_EXCL,
    );
    fs.writeFileSync(
      path.join(staged, "runtime.json"),
      `${JSON.stringify(
        {
          version: NODE_VERSION,
          platform,
          arch,
          binary: target.binary,
          binarySha256: target.binarySha256,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    await verifyNodeRuntime(staged, { platform, arch });
    fs.renameSync(staged, resolved);
    return path.join(resolved, target.binary);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
