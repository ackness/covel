import fs from "node:fs";
import { createHash } from "node:crypto";

export function assertDesktopTarget(platform: string, arch: string): void {
  if (
    !["darwin-arm64", "win32-x64", "linux-x64", "linux-arm64"].includes(
      `${platform}-${arch}`,
    )
  ) {
    throw new Error(`Unsupported desktop runtime target: ${platform}-${arch}`);
  }
}

export async function verifyRuntimeFile(
  file: string,
  expected: string,
): Promise<void> {
  if (!fs.lstatSync(file).isFile()) {
    throw new Error(`Runtime file must be regular (not a symlink): ${file}`);
  }
  const hash = createHash("sha256");
  // Use fs streams so Electron can read the actual entry inside app.asar
  // without blocking the main process on a large bundle.
  for await (const chunk of fs.createReadStream(file, {
    highWaterMark: 128 * 1024,
  })) {
    hash.update(chunk);
  }
  if (hash.digest("hex") !== expected) {
    throw new Error(`Runtime SHA256 mismatch: ${file}`);
  }
}
