import { parse } from "yaml";
import { z } from "zod";
import { validatePluginManifest, formatValidationErrors } from "@covel/shared";
import { httpError, type ExtractedEntry } from "./shared.js";

/** Installation parses data only; gray-matter also supports executable JS engines. */
export function readPluginFrontmatter(
  content: string,
): Record<string, unknown> {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    content,
  );
  if (!match)
    throw httpError(
      400,
      "PLUGIN.md requires plain YAML frontmatter; executable frontmatter is not supported",
    );
  return z.record(z.string(), z.unknown()).parse(parse(match[1]!));
}

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

export function validatePluginBundle(
  entries: readonly ExtractedEntry[],
  reservedPluginIds: ReadonlySet<string>,
): PluginManifestSummary {
  if (
    entries.some(
      (entry) => entry.relativePath.toLowerCase() === ".covel-install.json",
    )
  ) {
    throw httpError(400, "Plugin contains reserved installation metadata");
  }
  // Validate translations too: discovery can select a localized manifest
  // before session execution approval. Do not let one smuggle a JS engine.
  for (const entry of entries) {
    if (
      /^(?:runtimes\/[^/]+\/)?PLUGIN(?:\.[a-zA-Z0-9-]+)?\.md$/.test(
        entry.relativePath,
      )
    )
      readPluginFrontmatter(entry.content.toString("utf8"));
  }
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
    const parsed = readPluginFrontmatter(m.content.toString("utf-8"));
    const result = validatePluginManifest(parsed);
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
