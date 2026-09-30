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
import { compileRuntimeManifest } from "./compile-manifest.js";

function frontmatter(
  content: string,
  filePath: string,
  canonical?: Readonly<Record<string, unknown>>,
) {
  // Reject engine directives before gray-matter can select an executable parser.
  if (!/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(content)) {
    throw new Error("Manifest requires plain YAML frontmatter");
  }
  const parsed = matter(content, { language: "yaml" });
  return {
    body: parsed.content,
    data: canonical
      ? reconcileLocalizedManifest(canonical, parsed.data, filePath)
      : parsed.data,
  };
}
function invalid(filePath: string, error: unknown): never {
  throw new Error(
    `[plugin-loader] ${filePath}: invalid manifest frontmatter — ${error instanceof Error ? error.message : String(error)}\nFix: Use root PLUGIN.md {id,kind,contributes,runtime?} or runtime RUNTIME.md {type,schedule,io,agent/function}; old flat fields are not accepted.`,
  );
}
export function parsePluginMd(
  content: string,
  filePath: string,
  canonicalFrontmatter?: Readonly<Record<string, unknown>>,
): ParsedPluginMd {
  try {
    const { body, data } = frontmatter(content, filePath, canonicalFrontmatter);
    const plugin = pluginManifestSchema.parse(data);
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
): ParsedRuntimeMd {
  try {
    const { body, data } = frontmatter(content, filePath, canonicalFrontmatter);
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
          ([namespace, { version, accepts, ...decl }]) => [
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
