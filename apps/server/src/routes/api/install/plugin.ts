/**
 * Plugin install route.
 *
 * POST /api/install/plugin — multipart (field `file`), accepts a .zip containing
 *   either a root-level PLUGIN.md + package.json, or runtimes/<sub>/PLUGIN.md
 *   entries (multi-runtime layout). Extracts to the user plugins dir and
 *   returns `{ ok, id, restartRequired: true }`.
 */

import { homedir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import matter from "gray-matter";
import { errorBody } from "../../../api-error.js";
import {
  readRuntimeEnv,
  validatePluginManifest,
  formatValidationErrors,
} from "@covel/shared";
import { BUILTIN_PLUGIN_IDS } from "@covel/plugin-loader";
import {
  collectUpload,
  errorResponse,
  httpError,
  isBlobLike,
  materializeEntries,
  readAllEntries,
  rejectByContentLength,
  type ExtractedEntry,
} from "./shared.js";

export const pluginInstallRoutes = new Hono();

interface PluginManifestSummary {
  readonly pluginId: string;
}

function findPluginManifestEntry(
  entries: readonly ExtractedEntry[],
): ExtractedEntry | null {
  // Root-level PLUGIN.md (single-runtime layout).
  const root = entries.find((e) => e.relativePath === "PLUGIN.md");
  if (root) return root;
  // Multi-runtime layout: at least one runtimes/<sub>/PLUGIN.md must exist.
  const runtimeManifest = entries.find((e) =>
    /^runtimes\/[^/]+\/PLUGIN\.md$/.test(e.relativePath),
  );
  return runtimeManifest ?? null;
}

function readPackageId(entries: readonly ExtractedEntry[]): string | null {
  const pkg = entries.find((e) => e.relativePath === "package.json");
  if (!pkg) return null;
  try {
    const json = JSON.parse(pkg.content.toString("utf-8")) as {
      name?: unknown;
    };
    if (typeof json.name !== "string" || !json.name.trim()) return null;
    // `@covel/plugin-foo` → `plugin-foo`; `narrator` stays.
    const name = json.name.trim();
    const after = name.includes("/") ? name.split("/").slice(-1)[0] : name;
    return after;
  } catch {
    return null;
  }
}

/** Root segment of a plugin manifest `name` — handles `scope/sub` multi-runtime layouts. */
function manifestRootId(name: string): string {
  const trimmed = name.trim();
  return trimmed.includes("/") ? (trimmed.split("/")[0] ?? trimmed) : trimmed;
}

/**
 * Accept either exact equality or the Covel convention where `package.json`
 * uses `@covel/plugin-<id>` (basename: `plugin-<id>`) and `PLUGIN.md` declares
 * `name: <id>`. Both should map to the same logical plugin identity.
 */
function pluginIdsConsistent(pkgId: string, manifestRoot: string): boolean {
  if (pkgId === manifestRoot) return true;
  if (pkgId === `plugin-${manifestRoot}`) return true;
  return false;
}

function validatePluginBundle(
  entries: readonly ExtractedEntry[],
): PluginManifestSummary {
  const pkgId = readPackageId(entries);
  if (!pkgId) {
    throw httpError(400, 'package.json missing or has no valid "name" field');
  }
  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(pkgId)) {
    throw httpError(
      400,
      `invalid plugin id derived from package.json: ${pkgId}`,
    );
  }
  // Reserve builtin plugin IDs — third-party installs cannot shadow a shipped
  // plugin's `plugin_data` namespace by claiming the same name. The list lives
  // in `@covel/plugin-loader` (BUILTIN_PLUGIN_IDS) so it stays in sync with
  // the directory contents under `plugins/`.
  const pkgRoot = manifestRootId(pkgId);
  if (BUILTIN_PLUGIN_IDS.has(pkgRoot)) {
    throw httpError(
      409,
      `plugin id "${pkgRoot}" is reserved for a builtin plugin`,
    );
  }

  const manifestEntry = findPluginManifestEntry(entries);
  if (!manifestEntry) {
    throw httpError(
      400,
      "no PLUGIN.md found (expected root PLUGIN.md or runtimes/<sub>/PLUGIN.md)",
    );
  }

  // Validate every PLUGIN.md we find — multi-runtime layouts must all be valid —
  // AND enforce that each manifest's root `name` is consistent with the package.json id.
  // Without this check a bundle could install into dir `plugin-innocent` while
  // declaring `name: narrator`, which the loader would then treat as the
  // real narrator and collide with its plugin-data namespace.
  const manifests = entries.filter(
    (e) =>
      e.relativePath === "PLUGIN.md" ||
      /^runtimes\/[^/]+\/PLUGIN\.md$/.test(e.relativePath),
  );
  for (const m of manifests) {
    const parsed = matter(m.content.toString("utf-8"));
    const result = validatePluginManifest(parsed.data);
    if (!result.valid) {
      throw httpError(
        400,
        `invalid frontmatter in ${m.relativePath}:\n${formatValidationErrors(result.errors ?? [])}`,
      );
    }
    const declared = (result.data as { name?: unknown }).name;
    if (typeof declared !== "string" || declared.trim() === "") {
      throw httpError(
        400,
        `PLUGIN.md frontmatter in ${m.relativePath} missing "name"`,
      );
    }
    const declaredRoot = manifestRootId(declared);
    if (!pluginIdsConsistent(pkgId, declaredRoot)) {
      throw httpError(
        400,
        `plugin id mismatch: package.json name resolves to "${pkgId}" but ${m.relativePath} declares "${declaredRoot}"`,
      );
    }
  }

  return { pluginId: pkgId };
}

pluginInstallRoutes.post("/plugin", async (c) => {
  try {
    const tooLarge = rejectByContentLength(c.req.header("content-length"));
    if (tooLarge) throw tooLarge;

    const form = await c.req.formData();
    const file = form.get("file");
    if (!isBlobLike(file)) {
      return c.json(errorBody('multipart field "file" is required'), 400);
    }

    const buffer = await collectUpload(file);
    // First extract + validate against a throwaway sentinel root (path-traversal check
    // uses a fixed root string — entries get re-resolved under the final dir later).
    const entries = await readAllEntries(
      buffer,
      "/covel-plugin-install-sentinel",
    );
    const summary = validatePluginBundle(entries);

    const env = readRuntimeEnv();
    const root =
      env.userPluginsDir ??
      (env.covelHome
        ? path.join(env.covelHome, "plugins")
        : path.join(homedir(), ".covel", "plugins"));

    const finalDir = path.join(root, summary.pluginId);
    await materializeEntries(finalDir, entries);

    return c.json({
      ok: true,
      kind: "plugin",
      id: summary.pluginId,
      restartRequired: true,
    });
  } catch (err) {
    const { status, body } = errorResponse(err);
    return c.json(body, status as 400 | 409 | 413 | 500);
  }
});
