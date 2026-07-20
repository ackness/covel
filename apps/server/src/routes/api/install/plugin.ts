/**
 * Plugin install route.
 *
 * POST /api/install/plugin — multipart (field `file`), accepts a.zip containing
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
 * Canonical plugin ID for an npm basename: the Covel convention names the
 * package `@covel/plugin-<id>` while `PLUGIN.md` declares `name: <id>`, so a
 * single exact `plugin-` prefix is stripped for identity comparison. Nothing
 * else is normalized — the runtime identity IS the manifest root name.
 */
function canonicalFromPackageId(pkgId: string): string {
  return pkgId.startsWith("plugin-") ? pkgId.slice("plugin-".length) : pkgId;
}

function validatePluginBundle(
  entries: readonly ExtractedEntry[],
  reservedPluginIds: ReadonlySet<string>,
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

  const manifestEntry = findPluginManifestEntry(entries);
  if (!manifestEntry) {
    throw httpError(
      400,
      "no PLUGIN.md found (expected root PLUGIN.md or runtimes/<sub>/PLUGIN.md)",
    );
  }

  // Single canonical identity : the runtime, store, proposals, hooks and
  // trust checks all key on the manifest root name — so THAT is the identity
  // the reserved-ID check, install dir, and API response must use. The
  // package.json basename only participates as a consistency check after
  // stripping the exact `plugin-` prefix. The old code checked reserved IDs
  // against the un-stripped npm basename (`plugin-narrator`), letting a
  // bundle with `name: narrator` impersonate the builtin narrator.
  const canonicalId = canonicalFromPackageId(pkgId);
  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(canonicalId)) {
    throw httpError(400, `invalid canonical plugin id: ${canonicalId}`);
  }
  if (reservedPluginIds.has(canonicalId)) {
    throw httpError(
      409,
      `plugin id "${canonicalId}" is reserved for a builtin plugin`,
    );
  }

  // Validate every PLUGIN.md we find — multi-runtime layouts must all be
  // valid — AND enforce that each manifest's root `name` equals the canonical
  // ID. Any mismatch is a hard failure: the loader keys everything on the
  // manifest name, so a divergent package.json identity would let the check
  // above and the runtime identity disagree.
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
    if (declaredRoot !== canonicalId) {
      throw httpError(
        400,
        `plugin id mismatch: package.json name resolves to canonical id "${canonicalId}" but ${m.relativePath} declares "${declaredRoot}"`,
      );
    }
  }

  return { pluginId: canonicalId };
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
    // Reserved builtin ids are injected by the bootstrap DI middleware. Absent
    // only in bare test harnesses that mount the install routes directly — fall
    // back to an empty set so the route still functions there.
    const reservedPluginIds = c.get("reservedPluginIds") ?? new Set<string>();
    const summary = validatePluginBundle(entries, reservedPluginIds);

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
