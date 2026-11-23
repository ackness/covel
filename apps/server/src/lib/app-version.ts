import { createRequire } from "node:module";
import { satisfiesHostVersionRange } from "@covel/shared";
import {
  isSupportedPluginApiVersion,
  SUPPORTED_PLUGIN_API_VERSIONS,
} from "@covel/shared/platform";

/**
 * Running server version. Sourced from the @covel/server package.json so it
 * tracks releases automatically (a desktop shell may override via
 * COVEL_APP_VERSION). Falls back to "0.0.0" only if the manifest can't be read.
 */
export const APP_VERSION: string =
  process.env.COVEL_APP_VERSION ??
  (() => {
    try {
      const require = createRequire(import.meta.url);
      return (
        (require("../../package.json") as { version?: string }).version ??
        "0.0.0"
      );
    } catch {
      return "0.0.0";
    }
  })();

/**
 * Throws when `range` (a package's `covel` field) excludes this host. A host
 * version that cannot be parsed is not a mismatch.
 */
export function assertHostVersionInRange(
  subject: string,
  range: string | undefined,
): void {
  if (range && satisfiesHostVersionRange(APP_VERSION, range) === false)
    throw new Error(
      `${subject} needs Covel ${range}; this host runs ${APP_VERSION}`,
    );
}

/**
 * Fail-closed check for integer `apiVersion` in PLUGIN.md before loading or
 * importing any package code.
 */
export function assertPluginApiVersion(
  subject: string,
  apiVersion: number | undefined,
): void {
  if (apiVersion !== undefined && !isSupportedPluginApiVersion(apiVersion)) {
    throw new Error(
      `${subject} requires plugin apiVersion ${apiVersion}; this host supports [${SUPPORTED_PLUGIN_API_VERSIONS.join(", ")}]`,
    );
  }
}
