/** Strict current-format PLUGIN.md and RUNTIME.md authoring parsers. */
import matter from "gray-matter";
import path from "node:path";
import {
  pluginManifestSchema,
  runtimeAuthoringManifestSchema,
} from "@covel/shared";
import type { PluginManifest } from "@covel/shared";
import type { ParsedPluginMd } from "./types.js";
import { reconcileLocalizedManifest } from "./localized-manifest.js";
import { compileRuntimeManifest } from "./compile-manifest.js";

function frontmatter(
  content: string,
  filePath: string,
  canonical?: Readonly<Record<string, unknown>>,
) {
  const parsed = matter(content);
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
      ...(plugin.runtime ? { runtime: plugin.runtime } : {}),
      manifest: compileRuntimeManifest(plugin, plugin.runtime, plugin.id),
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
): ParsedPluginMd {
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
