/**
 * Progressive plugin loading — three levels of detail.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { PluginType } from '@covel/shared';
import type {
  PluginDiscoveryResult,
  PluginSummary,
  LoadedRuntime,
  ParsedPluginMd,
  ParsedReference,
  FunctionHandler,
} from './types.js';
import { parsePluginMd } from './parse-plugin-md.js';
import { parseReference } from './parse-reference.js';

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

async function resolveLocalizedPluginMd(dir: string, locale?: string): Promise<string> {
  const base = path.join(dir, 'PLUGIN.md');
  if (!locale || !SAFE_LOCALE_RE.test(locale)) return base;

  // Try exact locale: PLUGIN.en-US.md
  const exact = path.join(dir, `PLUGIN.${locale}.md`);
  if (await fileExists(exact)) return exact;

  // Try language prefix: PLUGIN.en.md
  const lang = locale.split('-')[0];
  if (lang !== locale) {
    const langPath = path.join(dir, `PLUGIN.${lang}.md`);
    if (await fileExists(langPath)) return langPath;
  }

  return base;
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
 * Check whether a path exists and is a directory.
 */
async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
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
export async function loadPluginSummary(discovery: PluginDiscoveryResult, locale?: string): Promise<PluginSummary> {
  // For multi-runtime, prefer root PLUGIN.md; fall back to first runtime's PLUGIN.md
  let summaryPath = await resolveLocalizedPluginMd(discovery.rootPath, locale);
  if (!(await fileExists(summaryPath))) {
    // Root PLUGIN.md doesn't exist (multi-runtime) — use first runtime's PLUGIN.md
    const fallbackDir = path.dirname(discovery.pluginMdPaths[0]);
    summaryPath = await resolveLocalizedPluginMd(fallbackDir, locale);
  }

  const content = await fs.readFile(summaryPath, 'utf-8');
  const { data } = matter(content);

  // Support I18nText: string or { "zh-CN": "...", "en-US": "..." } (reject arrays)
  const isI18n = (v: unknown): v is string | Record<string, string> =>
    typeof v === 'string' || (typeof v === 'object' && v !== null && !Array.isArray(v));
  const name = isI18n(data.name) ? data.name : discovery.id;
  const description = isI18n(data.description) ? data.description : '';
  const pluginType: PluginType =
    data.pluginType === 'core-plugin' ? 'core-plugin' : 'plugin';

  return {
    id: discovery.id,
    name,
    description,
    pluginType,
    runtimeCount: discovery.pluginMdPaths.length,
  };
}

/**
 * Level 1: Load full plugin manifest (all frontmatter fields).
 * Returns parsed PLUGIN.md for single-runtime, or all runtimes for multi-runtime.
 *
 * @param locale - Optional locale for loading localized PLUGIN.md
 */
export async function loadPluginManifest(discovery: PluginDiscoveryResult, locale?: string): Promise<readonly ParsedPluginMd[]> {
  const results: ParsedPluginMd[] = [];

  for (const mdPath of discovery.pluginMdPaths) {
    // Resolve localized version if available
    const dir = path.dirname(mdPath);
    const localizedPath = await resolveLocalizedPluginMd(dir, locale);
    const content = await fs.readFile(localizedPath, 'utf-8');
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
  const slashIdx = runtimeName.indexOf('/');
  const subName = slashIdx >= 0 ? runtimeName.slice(slashIdx + 1) : runtimeName;
  return path.join(discovery.rootPath, 'runtimes', subName);
}

/**
 * Read all reference files from a `references/` directory.
 */
async function readReferences(runtimeDir: string): Promise<readonly ParsedReference[]> {
  const refsDir = path.join(runtimeDir, 'references');
  if (!(await dirExists(refsDir))) {
    return [];
  }

  const entries = await fs.readdir(refsDir, { withFileTypes: true });
  const refs: ParsedReference[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const filePath = path.join(refsDir, entry.name);
    const content = await fs.readFile(filePath, 'utf-8');
    refs.push(parseReference(content, filePath));
  }

  return refs;
}

/**
 * Load UI spec JSON files declared in manifest.ui.
 * Validates paths to prevent traversal outside the plugin root.
 */
async function loadUiSpecs(
  runtimeDir: string,
  pluginRoot: string,
  ui: { right?: readonly string[]; message?: readonly string[]; left?: readonly string[] } | undefined,
): Promise<LoadedRuntime['uiSpecs']> {
  if (!ui) return undefined;

  const loadSlot = async (paths: readonly string[] | undefined): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> => {
    if (!paths || paths.length === 0) return undefined;
    const specs: Readonly<Record<string, unknown>>[] = [];
    for (const relPath of paths) {
      const fullPath = path.resolve(runtimeDir, relPath);
      const rel = path.relative(pluginRoot, fullPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`UI spec path traversal rejected: ${relPath}`);
      }
      if (fullPath.endsWith('.json')) {
        const content = await fs.readFile(fullPath, 'utf-8');
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
 * Reads prompt template, references, output schema.
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

  const content = await fs.readFile(pluginMdPath, 'utf-8');
  const parsed = parsePluginMd(content, pluginMdPath);

  const references = await readReferences(runtimeDir);

  const schemaPath = path.join(runtimeDir, 'output.schema.json');
  let outputSchema: Readonly<Record<string, unknown>> | undefined;
  if (await fileExists(schemaPath)) {
    const schemaContent = await fs.readFile(schemaPath, 'utf-8');
    outputSchema = JSON.parse(schemaContent) as Record<string, unknown>;
  }

  // Load function handler for runtimeType: 'function'
  let handler: FunctionHandler | undefined;
  if (parsed.manifest.runtimeType === 'function' && parsed.manifest.handler) {
    const handlerPath = path.resolve(runtimeDir, parsed.manifest.handler);
    // Security: prevent path traversal outside plugin root
    const rel = path.relative(discovery.rootPath, handlerPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Handler path traversal rejected: ${parsed.manifest.handler}`);
    }
    const mod = await import(handlerPath);
    handler = mod.default as FunctionHandler;
  }

  // Load guard function for agent runtimes with pre-execution gate
  let guard: FunctionHandler | undefined;
  if (parsed.manifest.guard) {
    const guardPath = path.resolve(runtimeDir, parsed.manifest.guard);
    const rel = path.relative(discovery.rootPath, guardPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Guard path traversal rejected: ${parsed.manifest.guard}`);
    }
    const mod = await import(guardPath);
    guard = mod.default as FunctionHandler;
  }

  // Load UI spec files from ui/ directory
  const uiSpecs = await loadUiSpecs(runtimeDir, discovery.rootPath, parsed.manifest.ui);

  return {
    manifest: parsed.manifest,
    promptTemplate: parsed.promptTemplate,
    references,
    outputSchema,
    handler,
    guard,
    uiSpecs,
  };
}
