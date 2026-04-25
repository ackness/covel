/**
 * Dev-only auto-bootstrap from `~/.covel/`.
 *
 * In dev (`NODE_ENV !== 'production'`) and outside the packaged desktop
 * sidecar (no `COVEL_DESKTOP_REST=1`), populate the relevant `COVEL_*`
 * env vars and `SQLITE_PATH` from `~/.covel/` before the rest of the
 * server boots. Without this, `pnpm dev` and `pnpm dev:electron` see an
 * empty repo-rooted state — bundled plugins only, no user-installed
 * plugins, fresh DB at `./data/covel.db`, no `~/.covel/keys.env` keys —
 * which doesn't match what the production desktop binary loads.
 *
 * The packaged desktop already sets `COVEL_DESKTOP_REST=1` plus explicit
 * `COVEL_USER_*` paths via `apps/desktop/src/main.ts`, so this module is
 * a no-op there. It is also a no-op when the user's home directory has
 * no `~/.covel/` (fresh checkouts on CI, ephemeral sandboxes, etc.).
 *
 * Existing process env values always win — `.env` / `.env.llm` overrides
 * are never overwritten. Each path is set only if both the env var is
 * unset AND the underlying file/directory actually exists.
 *
 * This module's top-level call runs at import time so the side effect
 * lands before `app.ts` evaluates its `readRuntimeEnv()` snapshot. Keep
 * imports light and synchronous.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface BootstrapSummary {
  readonly applied: boolean;
  readonly home?: string;
  readonly setVars: readonly string[];
  readonly loadedKeys: number;
  readonly skipReason?: string;
}

function setIfMissing(
  key: string,
  candidate: string,
  applied: string[],
): void {
  if (process.env[key]) return;
  if (!fs.existsSync(candidate)) return;
  process.env[key] = candidate;
  applied.push(key);
}

function loadKeysEnvIntoProcessEnv(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  let count = 0;
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return 0;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key || process.env[key]) continue;
    process.env[key] = value;
    count++;
  }
  return count;
}

function bootstrap(): BootstrapSummary {
  if (process.env.NODE_ENV === "production") {
    return { applied: false, setVars: [], loadedKeys: 0, skipReason: "production" };
  }
  if (process.env.COVEL_DESKTOP_REST === "1") {
    return { applied: false, setVars: [], loadedKeys: 0, skipReason: "desktop-sidecar" };
  }

  const home = process.env.COVEL_HOME ?? path.join(os.homedir(), ".covel");
  if (!fs.existsSync(home)) {
    return { applied: false, setVars: [], loadedKeys: 0, skipReason: "no-covel-home" };
  }

  const applied: string[] = [];
  setIfMissing("COVEL_USER_PLUGINS_DIR", path.join(home, "plugins"), applied);
  setIfMissing("COVEL_USER_WORLDS_DIR", path.join(home, "worlds"), applied);
  setIfMissing("COVEL_LLM_TOML", path.join(home, "llm.toml"), applied);
  setIfMissing("SQLITE_PATH", path.join(home, "data", "covel.db"), applied);

  const loadedKeys = loadKeysEnvIntoProcessEnv(path.join(home, "keys.env"));

  return { applied: true, home, setVars: applied, loadedKeys };
}

const summary = bootstrap();
if (summary.applied) {
  const parts = [
    `home=${summary.home}`,
    `vars=[${summary.setVars.join(", ") || "—"}]`,
    `keys=${summary.loadedKeys}`,
  ].join(" ");
  console.log(`[dev-home-bootstrap] applied ${parts}`);
} else if (summary.skipReason && summary.skipReason !== "production" && summary.skipReason !== "desktop-sidecar") {
  console.log(`[dev-home-bootstrap] skipped (${summary.skipReason})`);
}
