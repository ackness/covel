/**
 * Progressive plugin loading — three levels of detail.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import matter from "gray-matter";
import {
  pluginRelationsSchema,
  hasIllegalDetachedContract,
} from "@covel/shared";
import type {
  PluginRelations,
  PluginTag,
  PluginType,
  RuntimeManifest,
} from "@covel/shared";
import type {
  PluginDiscoveryResult,
  PluginSummary,
  LoadedRuntime,
  ParsedPluginMd,
  FunctionHandler,
} from "./types.js";
import { parsePluginMd } from "./parse-plugin-md.js";
import { reconcileLocalizedManifest } from "./localized-manifest.js";

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
 * Read + parse a plugin's PLUGIN.md for a locale.
 *
 * The prompt body comes from the locale variant (that is the point of having
 * one); the manifest is reconciled against the canonical PLUGIN.md so a
 * translation cannot change the runtime's execution contract — see
 * {@link reconcileLocalizedManifest}.
 */
async function parsePluginMdForLocale(
  dir: string,
  locale?: string,
): Promise<ParsedPluginMd> {
  const localizedPath = await resolveLocalizedPluginMd(dir, locale);
  const parsed = parsePluginMd(
    await fs.readFile(localizedPath, "utf-8"),
    localizedPath,
  );

  const basePath = path.join(dir, "PLUGIN.md");
  if (localizedPath === basePath) return parsed;

  const canonical = parsePluginMd(
    await fs.readFile(basePath, "utf-8"),
    basePath,
  );
  return {
    ...parsed,
    manifest: reconcileLocalizedManifest(
      canonical.manifest,
      parsed.manifest,
      localizedPath,
    ),
  };
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
    const parsed = await parsePluginMdForLocale(path.dirname(mdPath), locale);
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
 * Load a runtime's output JSON Schema.
 *
 * When `manifest.output.schema` declares a path, that exact file is loaded
 * (resolved against the runtime dir, containment-checked against the plugin
 * root); a declared-but-missing file warns instead of throwing so one bad
 * reference does not abort the load. With no declaration, fall back to the
 * `output.schema.json` convention — silently absent when the file is not there.
 */
async function loadOutputSchema(
  runtimeDir: string,
  pluginRoot: string,
  declaredPath: string | undefined,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (declaredPath) {
    const fullPath = path.resolve(runtimeDir, declaredPath);
    await assertInsideRoot(pluginRoot, fullPath, "Output schema");
    if (!(await fileExists(fullPath))) {
      console.warn(
        `[plugin-loader] declared output schema not found: ${declaredPath}`,
      );
      return undefined;
    }
    return JSON.parse(await fs.readFile(fullPath, "utf-8")) as Record<
      string,
      unknown
    >;
  }

  const conventionPath = path.join(runtimeDir, "output.schema.json");
  if (!(await fileExists(conventionPath))) return undefined;
  return JSON.parse(await fs.readFile(conventionPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

/**
 * Load a declared runtime-dir-relative JSON Schema (no convention fallback).
 * Used for `input.schema` (activation payload) and `inputs.<name>.accepts`
 * (binding value). Same containment + warn-on-missing contract as
 * {@link loadOutputSchema} — a bad reference degrades to `undefined`, never
 * aborts the load.
 */
async function loadDeclaredSchema(
  runtimeDir: string,
  pluginRoot: string,
  declaredPath: string,
  label: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const fullPath = path.resolve(runtimeDir, declaredPath);
  await assertInsideRoot(pluginRoot, fullPath, label);
  if (!(await fileExists(fullPath))) {
    console.warn(
      `[plugin-loader] declared ${label} not found: ${declaredPath}`,
    );
    return undefined;
  }
  return JSON.parse(await fs.readFile(fullPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

/**
 * Load every `inputs.<name>.accepts` schema declared on the manifest, keyed by
 * binding name. Absent / missing files are simply omitted (the runtime Ajv
 * check only runs where a schema resolved).
 */
async function loadBindingAcceptsSchemas(
  runtimeDir: string,
  pluginRoot: string,
  inputs: RuntimeManifest["inputs"],
): Promise<Record<string, Readonly<Record<string, unknown>>> | undefined> {
  if (!inputs) return undefined;
  const out: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [name, binding] of Object.entries(inputs)) {
    if (!binding.accepts) continue;
    const schema = await loadDeclaredSchema(
      runtimeDir,
      pluginRoot,
      binding.accepts,
      `binding accepts schema (${name})`,
    );
    if (schema) out[name] = schema;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Load every `input.inject` runtime-export `accepts` schema, keyed by the
 * binding `name`. Same containment / omit-on-missing rules as the same-execution
 * `inputs.<name>.accepts` loader (docs 02 §3.4.4).
 */
async function loadExportAcceptsSchemas(
  runtimeDir: string,
  pluginRoot: string,
  inject: NonNullable<RuntimeManifest["input"]>["inject"],
): Promise<Record<string, Readonly<Record<string, unknown>>> | undefined> {
  if (!inject) return undefined;
  const out: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const decl of inject) {
    if (decl.kind !== "runtime-export" || !decl.accepts) continue;
    const schema = await loadDeclaredSchema(
      runtimeDir,
      pluginRoot,
      decl.accepts,
      `export accepts schema (${decl.name})`,
    );
    if (schema) out[decl.name] = schema;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Level 1.5: Load only a runtime's manifest + UI specs — no handler / guard
 * imports. UI specs are data (JSON files, or a recorded component path), so
 * this path never executes plugin JS and is safe for untrusted (community)
 * plugins whose code must not run before approval.
 */
export async function loadRuntimeUi(
  discovery: PluginDiscoveryResult,
  runtimeName: string,
  locale?: string,
): Promise<Pick<LoadedRuntime, "manifest" | "uiSpecs">> {
  const runtimeDir = resolveRuntimeDir(discovery, runtimeName);
  const parsed = await parsePluginMdForLocale(runtimeDir, locale);
  const uiSpecs = await loadUiSpecs(
    runtimeDir,
    discovery.rootPath,
    parsed.manifest.ui,
  );
  return { manifest: parsed.manifest, uiSpecs };
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
  const parsed = await parsePluginMdForLocale(runtimeDir, locale);

  // Deterministic loader rejection (01 §4): a recurrently-detached spec that
  // still declares turn bindings can never satisfy them.
  if (hasIllegalDetachedContract(parsed.manifest)) {
    throw new Error(
      `Runtime "${parsed.manifest.name}" is always-detached (event/manual + background) ` +
        `but declares turn bindings (inputs) — no activation can satisfy them.`,
    );
  }

  const outputSchema = await loadOutputSchema(
    runtimeDir,
    discovery.rootPath,
    parsed.manifest.output?.schema,
  );

  const inputSchema = parsed.manifest.input?.schema
    ? await loadDeclaredSchema(
        runtimeDir,
        discovery.rootPath,
        parsed.manifest.input.schema,
        "input schema",
      )
    : undefined;

  const bindingAcceptsSchemas = await loadBindingAcceptsSchemas(
    runtimeDir,
    discovery.rootPath,
    parsed.manifest.inputs,
  );

  const exportAcceptsSchemas = await loadExportAcceptsSchemas(
    runtimeDir,
    discovery.rootPath,
    parsed.manifest.input?.inject,
  );

  // Load function handler for runtimeType: 'function'
  let handler: FunctionHandler | undefined;
  if (parsed.manifest.runtimeType === "function" && parsed.manifest.handler) {
    const handlerPath = path.resolve(runtimeDir, parsed.manifest.handler);
    await assertInsideRoot(discovery.rootPath, handlerPath, "Handler");
    const mod = await import(pathToFileURL(handlerPath).href);
    handler = mod.default as FunctionHandler;
  }

  // Load guard function for agent runtimes with pre-execution gate
  let guard: FunctionHandler | undefined;
  if (parsed.manifest.guard) {
    const guardPath = path.resolve(runtimeDir, parsed.manifest.guard);
    await assertInsideRoot(discovery.rootPath, guardPath, "Guard");
    const mod = await import(pathToFileURL(guardPath).href);
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
    ...(inputSchema ? { inputSchema } : {}),
    ...(bindingAcceptsSchemas ? { bindingAcceptsSchemas } : {}),
    ...(exportAcceptsSchemas ? { exportAcceptsSchemas } : {}),
    handler,
    guard,
    uiSpecs,
  };
}
