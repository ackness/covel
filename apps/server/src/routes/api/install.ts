/**
 * API Install routes — drag-and-drop import of plugin + world packages.
 *
 * Thin composition root. The plugin and world install handlers (and the shared
 * zip-extraction / path-safety helpers) live in `install/`:
 *   - `install/shared.ts`  — limits, zip extraction, atomic materialise, errors.
 *   - `install/plugin.ts`  — POST /plugin.
 *   - `install/worlds.ts`  — POST /world.
 *
 * Security (full detail in `install/shared.ts`):
 *   - Zip-slip protection, absolute/traversal/symlink rejection.
 *   - Size + entry-count + expansion-ratio caps (zip bombs).
 *   - Manifests must validate via shared Zod schemas before any files are written.
 *   - Target directory must not already exist (409) — updates use a separate consent and startup replacement flow.
 */

import { Hono } from "hono";
import { makeInstallApiGuard } from "../privileged-auth.js";
import { pluginInstallRoutes } from "./install/plugin.js";
import { worldInstallRoutes } from "./install/worlds.js";
import { createGithubInstallRoutes } from "./install/github-install.js";

import { createGithubUpdateRoutes } from "./install/github-updates.js";
import { createInstalledPackageRoutes } from "./install/installed-packages.js";

export const installRoutes = new Hono();
installRoutes.use("*", makeInstallApiGuard());

installRoutes.route("/", pluginInstallRoutes);
for (const kind of ["plugin", "world"] as const) {
  installRoutes.route("/", createInstalledPackageRoutes(kind));
  installRoutes.route("/", createGithubInstallRoutes(kind));
  installRoutes.route("/", createGithubUpdateRoutes(kind));
}
installRoutes.route("/", worldInstallRoutes);
