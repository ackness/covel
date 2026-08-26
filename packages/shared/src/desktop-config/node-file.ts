import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  parseDesktopConfig,
  patchDesktopConfigSource,
  type DesktopConfig,
  type DesktopConfigPatch,
} from "./schema.js";

export {
  DESKTOP_CONFIG_SCHEMA_VERSION,
  DESKTOP_PROXY_MODES,
  desktopConfigSchema,
  parseDesktopConfig,
  patchDesktopConfigSource,
} from "./schema.js";
export type {
  DesktopConfig,
  DesktopConfigPatch,
  DesktopProxyMode,
} from "./schema.js";

export function readDesktopConfigFile(file: string): DesktopConfig {
  const source = existsSync(file) ? readFileSync(file, "utf-8") : "";
  return parseDesktopConfig(source);
}

/** Validate and atomically replace a private desktop config file. */
export function writeDesktopConfigFileAtomic(
  file: string,
  source: string,
): void {
  parseDesktopConfig(source);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, source, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

/** Strict read-modify-validate-write for one focused config patch. */
export function patchDesktopConfigFile(
  file: string,
  patch: DesktopConfigPatch,
): DesktopConfig {
  const source = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const next = patchDesktopConfigSource(source, patch);
  writeDesktopConfigFileAtomic(file, next);
  return parseDesktopConfig(next);
}
