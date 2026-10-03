import { createRequire } from "node:module";

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
