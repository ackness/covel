import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { compareVersions } from "./app-update.js";

interface AppUpdateState {
  readonly schemaVersion: 1;
  readonly ignoredVersion: string;
}

export function readIgnoredUpdateVersion(
  stateFile: string,
): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const state = value as Partial<AppUpdateState>;
    if (
      state.schemaVersion !== 1 ||
      typeof state.ignoredVersion !== "string" ||
      compareVersions(state.ignoredVersion, state.ignoredVersion) !== 0
    ) {
      return undefined;
    }
    return state.ignoredVersion;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export function writeIgnoredUpdateVersion(
  stateFile: string,
  version: string,
): void {
  if (compareVersions(version, version) !== 0) {
    throw new Error("ignored update version must be valid SemVer");
  }
  const state: AppUpdateState = { schemaVersion: 1, ignoredVersion: version };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporaryFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    fs.chmodSync(temporaryFile, 0o600);
    fs.renameSync(temporaryFile, stateFile);
    fs.chmodSync(stateFile, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}
