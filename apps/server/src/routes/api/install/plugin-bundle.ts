import path from "node:path";
import {
  packageModuleTypeProblem,
  readPlainYamlFrontmatter,
  runtimeDirectoryDiagnostics,
  parsePluginMd,
  validatePluginFiles,
  compileInlineRuntime,
  parseRuntimeMd,
  validatePluginDeclarations,
  multiRuntimeRootDiagnostics,
  type ParsedRuntimeMd,
} from "@covel/plugin-loader";
import { assertHostVersionInRange } from "../../../lib/app-version.js";
import {
  assertNoReservedInstallFiles,
  httpError,
  type ExtractedEntry,
} from "./shared.js";

/** Installation reports parsing errors as invalid package input. */
export function readPluginFrontmatter(
  content: string,
): Record<string, unknown> {
  try {
    return readPlainYamlFrontmatter(content).data;
  } catch (error) {
    throw httpError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

interface PluginManifestSummary {
  readonly pluginId: string;
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
    return name.split("/").at(-1) ?? name;
  } catch {
    return null;
  }
}

/**
 * Canonical plugin ID for an npm basename: the Covel convention names the
 * package `@covel/plugin-<id>` while `PLUGIN.md` declares `id: <id>`, so a
 * single exact `plugin-` prefix is stripped for identity comparison. Nothing
 * else is normalized — the runtime identity IS the root manifest id.
 */
function canonicalFromPackageId(pkgId: string): string {
  return pkgId.startsWith("plugin-") ? pkgId.slice("plugin-".length) : pkgId;
}

export function validatePluginBundle(
  entries: readonly ExtractedEntry[],
  reservedPluginIds: ReadonlySet<string>,
): PluginManifestSummary {
  assertNoReservedInstallFiles(entries);
  // Validate translations too: discovery can select a localized manifest
  // before session execution approval. Do not let one smuggle a JS engine.
  for (const entry of entries) {
    if (
      /^(?:PLUGIN(?:\.[a-zA-Z0-9-]+)?|runtimes\/[^/]+\/(?:PLUGIN|RUNTIME)(?:\.[a-zA-Z0-9-]+)?)\.md$/.test(
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

  const manifestEntry = entries.find(
    (entry) => entry.relativePath === "PLUGIN.md",
  );
  if (!manifestEntry) {
    throw httpError(
      400,
      "no root PLUGIN.md found; every plugin requires a root declaration",
    );
  }

  // Single canonical identity : the runtime, store, proposals, hooks and
  // trust checks all key on the root manifest id — so THAT is the identity
  // the reserved-ID check, install dir, and API response must use. The
  // package.json basename only participates as a consistency check after
  // stripping the exact `plugin-` prefix. The old code checked reserved IDs
  // against the un-stripped npm basename (`plugin-narrator`), letting a
  // bundle with `name: narrator` impersonate the builtin narrator.
  const canonicalId = canonicalFromPackageId(pkgId);
  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(canonicalId)) {
    throw httpError(400, `invalid canonical plugin id: ${canonicalId}`);
  }
  // The ID format check is case-insensitive, so compare case-insensitively too.
  const lowerId = canonicalId.toLowerCase();
  if ([...reservedPluginIds].some((id) => id.toLowerCase() === lowerId)) {
    throw httpError(
      409,
      `plugin id "${canonicalId}" is reserved for a builtin plugin`,
    );
  }

  const runtimeFiles = new Map<string, string[]>();
  for (const entry of entries) {
    const match = /^runtimes\/([^/]+)\/(.+)$/.exec(entry.relativePath);
    const directory = match?.[1];
    const file = match?.[2];
    if (!directory || !file) continue;
    const files = runtimeFiles.get(directory) ?? [];
    files.push(file);
    runtimeFiles.set(directory, files);
  }
  for (const [directory, files] of runtimeFiles) {
    const diagnostic = runtimeDirectoryDiagnostics(
      `runtimes/${directory}`,
      files,
    );
    const problem = diagnostic.error ?? diagnostic.warning;
    if (problem) throw httpError(400, problem);
  }
  const children = entries.filter((entry) =>
    /^runtimes\/[^/]+\/RUNTIME\.md$/.test(entry.relativePath),
  );
  try {
    const root = parsePluginMd(
      manifestEntry.content.toString("utf8"),
      `${canonicalId}/PLUGIN.md`,
    );
    if (root.plugin!.id !== canonicalId)
      throw new Error(
        `plugin id mismatch: package.json resolves to "${canonicalId}" but PLUGIN.md declares "${root.plugin!.id}"`,
      );
    // Refuse a package written for another host before any file is written.
    assertHostVersionInRange(`Plugin ${canonicalId}`, root.plugin!.covel);
    if (entries.some((entry) => entry.relativePath.startsWith("runtimes/"))) {
      const diagnostics = multiRuntimeRootDiagnostics(root.rawFrontmatter);
      if (diagnostics.length)
        throw new Error(diagnostics.map((d) => d.message).join("\n"));
    }
    const inline = compileInlineRuntime(root);
    const declarations: ParsedRuntimeMd[] = inline ? [inline] : [];
    for (const child of children)
      declarations.push(
        parseRuntimeMd(
          child.content.toString("utf8"),
          `${canonicalId}/${child.relativePath}`,
          root.plugin!,
        ),
      );
    validatePluginDeclarations(root);
    validatePluginFiles(root, declarations, (absolutePath) => {
      const relative = path
        .relative(path.resolve(canonicalId), absolutePath)
        .split(path.sep)
        .join("/");
      const entry = entries.find(
        (candidate) => candidate.relativePath === relative,
      );
      if (!entry) throw new Error("File not found");
      return entry.content.toString("utf8");
    });
    const packaged = JSON.parse(
      entries
        .find((entry) => entry.relativePath === "package.json")!
        .content.toString("utf8"),
    ) as { version?: string; type?: unknown };
    if (
      root.plugin.version &&
      packaged.version &&
      root.plugin.version !== packaged.version
    )
      throw new Error(
        "PLUGIN.md and package.json must declare the same version",
      );
    const moduleProblem = packageModuleTypeProblem(packaged);
    if (moduleProblem) throw new Error(moduleProblem);
    // Localizations may change presentation only; identity and code declarations
    // are reconciled against the canonical document before installation.
    for (const entry of entries) {
      if (/^PLUGIN\.[a-zA-Z0-9-]+\.md$/.test(entry.relativePath)) {
        parsePluginMd(
          entry.content.toString("utf8"),
          `${canonicalId}/${entry.relativePath}`,
          root.rawFrontmatter,
        );
      } else if (
        /^runtimes\/[^/]+\/RUNTIME\.[a-zA-Z0-9-]+\.md$/.test(entry.relativePath)
      ) {
        const canonicalPath = entry.relativePath.replace(
          /RUNTIME\.[^.]+\.md$/,
          "RUNTIME.md",
        );
        const canonical = declarations.find(
          (record) => record.sourcePath === `${canonicalId}/${canonicalPath}`,
        );
        if (!canonical)
          throw new Error(
            `Localized runtime has no canonical RUNTIME.md: ${entry.relativePath}`,
          );
        parseRuntimeMd(
          entry.content.toString("utf8"),
          `${canonicalId}/${entry.relativePath}`,
          root.plugin!,
          canonical.rawFrontmatter,
        );
      }
    }
  } catch (error) {
    throw httpError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }

  return { pluginId: canonicalId };
}
