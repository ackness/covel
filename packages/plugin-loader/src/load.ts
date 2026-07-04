/**
 * Progressive plugin loading — three levels of detail.
 */

import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { pluginRelationsSchema } from "@covel/shared";
import type { PluginRelations, PluginTag, PluginType } from "@covel/shared";
import type {
  PluginDiscoveryResult,
  PluginSummary,
  LoadedRuntime,
  ParsedPluginMd,
  FunctionHandler,
} from "./types.js";
import { parsePluginMd } from "./parse-plugin-md.js";

/**
 * Resolve a locale-aware PLUGIN.md path.
 *
 * Resolution order (e.g., locale = "en-US"):
 *   1. PLUGIN.en-US.md  (exact locale)
 *   2. PLUGIN.en.md     (language only)
 *   3. PLUGIN.md         (default fallback)
 *
 * Returns the path of the first existing file, or the default PLUGIN.md.
 */
/** Only allow safe BCP-47-like locale tags in filesystem paths. */
const SAFE_LOCALE_RE = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/;

async function resolveLocalizedPluginMd(
  dir: string,
  locale?: string,
): Promise<string> {
  const base = path.join(dir, "PLUGIN.md");
  if (!locale || !SAFE_LOCALE_RE.test(locale)) return base;

  // Try exact locale: PLUGIN.en-US.md
  const exact = path.join(dir, `PLUGIN.${locale}.md`);
  if (await fileExists(exact)) return exact;

  // Try language prefix: PLUGIN.en.md
  const lang = locale.split("-")[0];
  if (lang !== locale) {
    const langPath = path.join(dir, `PLUGIN.${lang}.md`);
    if (await fileExists(langPath)) return langPath;
  }

  return base;
}

/**
 * Validate that `target` is inside `root` after resolving symlinks.
 * Uses fs.realpath() to defeat symlink-based path traversal.
 * Falls back to lexical check when the target does not exist on disk.
 */
async function assertInsideRoot(
  root: string,
  target: string,
  label: string,
): Promise<void> {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    realRoot = path.resolve(root);
  }
  try {
    realTarget = await fs.realpath(target);
  } catch {
    // Target doesn't exist — fall back to lexical check (safe: non-existent path can't be read)
    realTarget = path.resolve(target);
  }
  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} path traversal rejected`);
  }
}

/**
 * Check whether a path exists and is a file.
 */
async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Level 0: Load lightweight plugin summary.
 * Only reads frontmatter `name` and `description` fields.
 *
 * @param locale - Optional locale for loading localized PLUGIN.md
 */
export async function loadPluginSummary(
  discovery: PluginDiscoveryResult,
  locale?: string,
): Promise<PluginSummary> {
  // For multi-runtime, prefer root PLUGIN.md; fall back to first runtime's PLUGIN.md
  let summaryPath = await resolveLocalizedPluginMd(discovery.rootPath, locale);
  const hasRootSummary = await fileExists(summaryPath);
  if (!hasRootSummary) {
    // Root PLUGIN.md doesn't exist (multi-runtime) — use first runtime's PLUGIN.md
    const fallbackDir = path.dirname(discovery.pluginMdPaths[0]);
    summaryPath = await resolveLocalizedPluginMd(fallbackDir, locale);
  }

  const content = await fs.readFile(summaryPath, "utf-8");
  const { data } = matter(content);

  // Support I18nText: string or { "zh-CN": "...", "en-US": "..." } (reject arrays)
  const isI18n = (v: unknown): v is string | Record<string, string> =>
    typeof v === "string" ||
    (typeof v === "object" && v !== null && !Array.isArray(v));
  const name = hasRootSummary
    ? isI18n(data.name)
      ? data.name
      : discovery.id
    : discovery.id;
  // Friendly display name (I18nText) — only meaningful from the root summary.
  const displayName =
    hasRootSummary && isI18n(data.displayName) ? data.displayName : undefined;
  const description = isI18n(data.description) ? data.description : "";
  const pluginType: PluginType =
    data.pluginType === "core-plugin" ? "core-plugin" : "plugin";

  const tags = stringArray(data.tags);
  const relations = parseSummaryRelations(data.relations);

  return {
    id: discovery.id,
    name,
    ...(displayName ? { displayName } : {}),
    description,
    pluginType,
    runtimeCount: discovery.pluginMdPaths.length,
    ...(tags.length > 0 ? { tags: tags as PluginTag[] } : {}),
    ...(relations ? { relations } : {}),
  };
}

/**
 * Level 1: Load full plugin manifest (all frontmatter fields).
 * Returns parsed PLUGIN.md for single-runtime, or all runtimes for multi-runtime.
 *
 * @param locale - Optional locale for loading localized PLUGIN.md
 */
export async function loadPluginManifest(
  discovery: PluginDiscoveryResult,
  locale?: string,
): Promise<readonly ParsedPluginMd[]> {
  const results: ParsedPluginMd[] = [];

  for (const mdPath of discovery.pluginMdPaths) {
    // Resolve localized version if available
    const dir = path.dirname(mdPath);
    const localizedPath = await resolveLocalizedPluginMd(dir, locale);
    const content = await fs.readFile(localizedPath, "utf-8");
    const parsed = parsePluginMd(content, localizedPath);
    results.push(parsed);
  }

  return results;
}

/**
 * Resolve the directory for a given runtime name within a discovery result.
 */
function resolveRuntimeDir(
  discovery: PluginDiscoveryResult,
  runtimeName: string,
): string {
  if (!discovery.isMultiRuntime) {
    return discovery.rootPath;
  }
  // runtimeName may be 'pluginId/subName' — extract the subName for directory resolution
  const slashIdx = runtimeName.indexOf("/");
  const subName = slashIdx >= 0 ? runtimeName.slice(slashIdx + 1) : runtimeName;
  return path.join(discovery.rootPath, "runtimes", subName);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseSummaryRelations(value: unknown): PluginRelations | undefined {
  const parsed = pluginRelationsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Load UI spec JSON files declared in manifest.ui.
 * Validates paths to prevent traversal outside the plugin root.
 */
async function loadUiSpecs(
  runtimeDir: string,
  pluginRoot: string,
  ui:
    | {
        right?: readonly string[];
        message?: readonly string[];
        left?: readonly string[];
      }
    | undefined,
): Promise<LoadedRuntime["uiSpecs"]> {
  if (!ui) return undefined;

  const loadSlot = async (
    paths: readonly string[] | undefined,
  ): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> => {
    if (!paths || paths.length === 0) return undefined;
    const specs: Readonly<Record<string, unknown>>[] = [];
    for (const relPath of paths) {
      const fullPath = path.resolve(runtimeDir, relPath);
      await assertInsideRoot(pluginRoot, fullPath, "UI spec");
      if (fullPath.endsWith(".json")) {
        const content = await fs.readFile(fullPath, "utf-8");
        specs.push(JSON.parse(content) as Record<string, unknown>);
      } else {
        // .tsx/.js — store path for frontend dynamic loading
        specs.push({ _componentPath: relPath });
      }
    }
    return specs;
  };

  const right = await loadSlot(ui.right);
  const message = await loadSlot(ui.message);
  const left = await loadSlot(ui.left);

  if (!right && !message && !left) return undefined;
  return { right, message, left };
}

/**
 * Level 2: Fully load a runtime for execution.
 * Reads prompt template, output schema.
 *
 * @param locale - Optional locale for loading localized PLUGIN.md (e.g., "en-US" → PLUGIN.en.md)
 */
export async function loadRuntime(
  discovery: PluginDiscoveryResult,
  runtimeName: string,
  locale?: string,
): Promise<LoadedRuntime> {
  const runtimeDir = resolveRuntimeDir(discovery, runtimeName);
  const pluginMdPath = await resolveLocalizedPluginMd(runtimeDir, locale);

  const content = await fs.readFile(pluginMdPath, "utf-8");
  const parsed = parsePluginMd(content, pluginMdPath);

  const schemaPath = path.join(runtimeDir, "output.schema.json");
  let outputSchema: Readonly<Record<string, unknown>> | undefined;
  if (await fileExists(schemaPath)) {
    const schemaContent = await fs.readFile(schemaPath, "utf-8");
    outputSchema = JSON.parse(schemaContent) as Record<string, unknown>;
  }

  // Load function handler for runtimeType: 'function'
  let handler: FunctionHandler | undefined;
  if (parsed.manifest.runtimeType === "function" && parsed.manifest.handler) {
    const handlerPath = path.resolve(runtimeDir, parsed.manifest.handler);
    await assertInsideRoot(discovery.rootPath, handlerPath, "Handler");
    const mod = await import(handlerPath);
    handler = mod.default as FunctionHandler;
  }

  // Load guard function for agent runtimes with pre-execution gate
  let guard: FunctionHandler | undefined;
  if (parsed.manifest.guard) {
    const guardPath = path.resolve(runtimeDir, parsed.manifest.guard);
    await assertInsideRoot(discovery.rootPath, guardPath, "Guard");
    const mod = await import(guardPath);
    if (typeof mod.default !== "function") {
      throw new Error(
        `Guard module "${parsed.manifest.guard}" does not export a default function (got ${typeof mod.default})`,
      );
    }
    guard = mod.default as FunctionHandler;
  }

  // Load UI spec files from ui/ directory
  const uiSpecs = await loadUiSpecs(
    runtimeDir,
    discovery.rootPath,
    parsed.manifest.ui,
  );

  return {
    manifest: parsed.manifest,
    promptTemplate: parsed.promptTemplate,
    outputSchema,
    handler,
    guard,
    uiSpecs,
  };
}
