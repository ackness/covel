import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The Node version `mise.toml` pins, or undefined without a pin. */
export function pinnedNodeVersion(repoRoot) {
  const miseToml = path.join(repoRoot, "mise.toml");
  if (!existsSync(miseToml)) return undefined;
  return /^\s*node\s*=\s*"([^"]+)"/m.exec(readFileSync(miseToml, "utf8"))?.[1];
}

/**
 * Refuse to continue on a Node other than the pinned one. Another Node manager
 * ahead of mise on PATH would otherwise fail checks in confusing ways.
 */
export function requireProjectNode(repoRoot, label) {
  const pinned = pinnedNodeVersion(repoRoot);
  if (!pinned || process.versions.node === pinned) return;
  console.error(
    `[${label}] Node ${process.versions.node} is running this check, but mise.toml pins Node ${pinned}. ` +
      "Run `mise install`, and make sure no other Node manager (such as nvm) comes before mise on PATH.",
  );
  process.exit(1);
}
