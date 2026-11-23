/**
 * Persistent installation-scoped host identity (`instance-id`).
 *
 * Stored in `<configDir>/instance-id` so instance plugins can associate host-level
 * state (e.g. account bindings or device labels) with one stable ID across
 * restarts without exposing raw filesystem paths or OS machine fingerprints.
 */

import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const INSTANCE_ID_FILENAME = "instance-id";

const INSTANCE_ID_RE = /^[a-zA-Z0-9-]{8,128}$/;

function isNodeErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Load the existing installation host ID from `<configDir>/instance-id`, or
 * atomically generate and persist a fresh UUID when absent or malformed.
 */
export async function loadOrCreateHostId(configDir: string): Promise<string> {
  const filePath = path.join(configDir, INSTANCE_ID_FILENAME);
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (INSTANCE_ID_RE.test(existing)) {
      return existing;
    }
  } catch (error) {
    if (!isNodeErrno(error, "ENOENT")) {
      throw error;
    }
  }

  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const nextId = randomUUID();
  const tmpPath = path.join(configDir, `.instance-id.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, `${nextId}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmpPath, filePath);
    if (process.platform !== "win32") {
      await chmod(filePath, 0o600).catch(() => {});
    }
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  return nextId;
}
