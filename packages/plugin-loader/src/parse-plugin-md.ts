/** Strict current-format PLUGIN.md and RUNTIME.md authoring parsers. */
import matter from "gray-matter";
import path from "node:path";
import {
  pluginManifestSchema,
  runtimeAuthoringManifestSchema,
  resolveI18nText,
} from "@covel/shared";
import type { PluginManifest } from "@covel/shared";
import type {
  ParsedPluginMd,
  ParsedRuntimeMd,
  PackageManifest,
} from "./types.js";
import { reconcileLocalizedManifest } from "./localized-manifest.js";
import { compileManifestLabels, type ManifestLabels } from "./locale-labels.js";
import { compileRuntimeManifest } from "./compile-manifest.js";

function frontmatter(
  content: string,
  filePath: string,
  canonical?: Readonly<Record<string, unknown>>,
  labels?: readonly ManifestLabels[],
) {
  // Reject engine directives before gray-matter can select an executable parser.
  // The block may be empty: a language variant that translates only the body
  // has nothing to declare.
  if (!/^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.test(content)) {
    throw new Error("Manifest requires plain YAML frontmatter");
  }
  const parsed = matter(content, { language: "yaml" });
  let data = parsed.data;
  if (labels?.length) {
    // Label translations from `locales/<locale>.yaml` become locale maps
    // before validation, so the manifest is the same as one that wrote them
    // inline.
    const compiled = compileManifestLabels(data, labels);
    data = compiled.data;
    for (const issue of compiled.issues)
      console.warn(
        `[plugin-loader] ${filePath}: ${issue.file}: ${issue.path} ${issue.message}; this translation is ignored`,
      );
  }
  return {
    body: parsed.content,
    data: canonical
      ? reconcileLocalizedManifest(canonical, data, filePath)
      : data,
  };
}
function invalid(filePath: string, error: unknown): never {
  const details =
    error instanceof Error && "issues" in error && Array.isArray(error.issues)
      ? (error.issues as { path: PropertyKey[]; message: string }[])
          .map(
            (issue) =>
              `${filePath}: ${issue.path.join(".") || "frontmatter"}: ${issue.message}; correct this field using the current plugin manifest reference`,
          )
          .join("\n")
      : `${filePath}: ${error instanceof Error ? error.message : String(error)}`;
  throw new Error(`[plugin-loader] invalid manifest frontmatter\n${details}`);
}
export function parsePluginMd(
  content: string,
  filePath: string,
  canonicalFrontmatter?: Readonly<Record<string, unknown>>,
  /** Label translations of this file; see `readManifestLabels`. */
  labels?: readonly ManifestLabels[],
): ParsedPluginMd {
  try {
    const { body, data } = frontmatter(
      content,
      filePath,
      canonicalFrontmatter,
      labels,
    );
    const plugin = withContractDefaults(pluginManifestSchema.parse(data));
    return {
      sourcePath: filePath,
      plugin,
      manifest: normalizePackageManifest(plugin),
      promptTemplate: body,
      rawFrontmatter: data,
    };
  } catch (error) {
    return invalid(filePath, error);
  }
}
export function parseRuntimeMd(
  content: string,
  filePath: string,
  plugin: PluginManifest,
  canonicalFrontmatter?: Readonly<Record<string, unknown>>,
  /** Label translations of this file; see `readManifestLabels`. */
  labels?: readonly ManifestLabels[],
): ParsedRuntimeMd {
  try {
    const { body, data } = frontmatter(
      content,
      filePath,
      canonicalFrontmatter,
      labels,
    );
    const runtime = runtimeAuthoringManifestSchema.parse(data);
    const localId = path.basename(path.dirname(filePath));
    if (!/^[a-z][a-z0-9-]*$/.test(localId))
      throw new Error(`Invalid runtime directory name: ${localId}`);
    return {
      sourcePath: filePath,
      runtime,
      manifest: compileRuntimeManifest(
        plugin,
        runtime,
        `${plugin.id}/${localId}`,
      ),
      promptTemplate: body,
      rawFrontmatter: data,
    };
  } catch (error) {
    return invalid(filePath, error);
  }
}

/**
 * A data namespace that accepts a contract states the schema of its records.
 * That is the schema of the contract, so `contracts` does not have to repeat
 * the path. An entry written in `contracts` is kept as it is. A contract that
 * two namespaces accept with different schemas gets no default: the manifest
 * must say which one is public.
 */
function withContractDefaults(plugin: PluginManifest): PluginManifest {
  const accepted = new Map<string, Set<string>>();
  for (const declaration of Object.values(plugin.contributes?.data ?? {}))
    for (const contract of declaration.accepts ?? []) {
      const schemas = accepted.get(contract) ?? new Set<string>();
      schemas.add(declaration.schema);
      accepted.set(contract, schemas);
    }
  const derived = Object.fromEntries(
    [...accepted]
      .filter(
        ([contract, schemas]) =>
          schemas.size === 1 && !plugin.contracts?.[contract],
      )
      .map(([contract, schemas]) => [contract, { schema: [...schemas][0]! }]),
  );
  return Object.keys(derived).length === 0
    ? plugin
    : { ...plugin, contracts: { ...derived, ...plugin.contracts } };
}

/** Normalize package declarations independently of runtime compilation. */
export function normalizePackageManifest(
  plugin: PluginManifest,
): PackageManifest {
  const c = plugin.contributes;
  return {
    name: plugin.id,
    pluginId: plugin.id,
    description: resolveI18nText(plugin.description, "en") ?? "",
    pluginType: plugin.kind === "core" ? "core-plugin" : "plugin",
    displayName: plugin.displayName,
    version: plugin.version,
    tags: plugin.tags,
    entry: plugin.entry,
    extensions: c?.extensions,
    commands: c?.commands,
    events: c?.events,
    userSettings: c?.settings,
    worldProjections: c?.worldProjections,
    ui: c?.ui,
    dataSchemas:
      c?.data &&
      Object.fromEntries(
        Object.entries(c.data).map(
          // `authoring` is for world authors and tools, and `search` is read
          // by the host's memory search from the package manifest; the
          // runtime data schema declaration carries neither.
          ([
            namespace,
            {
              version,
              accepts,
              authoring: _authoring,
              search: _search,
              ...decl
            },
          ]) => [
            namespace,
            {
              ...decl,
              namespace,
              schemaVersion: version,
              acceptsWorldData: Boolean(accepts?.length),
            },
          ],
        ),
      ),
  };
}

/** Compile only explicitly declared inline execution. */
export function compileInlineRuntime(
  parsed: ParsedPluginMd,
): ParsedRuntimeMd | undefined {
  const runtime = parsed.plugin.runtime;
  if (!runtime) return undefined;
  return {
    sourcePath: parsed.sourcePath,
    runtime,
    manifest: compileRuntimeManifest(parsed.plugin, runtime, parsed.plugin.id),
    promptTemplate: parsed.promptTemplate,
    rawFrontmatter: parsed.rawFrontmatter,
  };
}
