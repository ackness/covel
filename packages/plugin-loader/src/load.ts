import { loadPluginUiSpec } from "./ui-spec.js";
/**
 * Progressive plugin loading — three levels of detail.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_FALLBACK_LOCALE,
  DEFAULT_LOCALE,
  canonicalizeLocale,
  localeLookupCandidates,
  localeRegistry,
  hasIllegalDetachedContract,
  normalizeLocale,
  WORLD_IR_V1_JSON_SCHEMA,
  WORLD_IR_V1_SCHEMA_URI,
} from "@covel/shared";
import type { RuntimeManifest } from "@covel/shared";
import type {
  PluginDiscoveryResult,
  PluginSummary,
  PluginEntryDefinition,
  LoadedRuntime,
  ParsedPluginMd,
  FunctionHandler,
  AgentGuard,
} from "./types.js";
import { parsePluginMd } from "./parse-plugin-md.js";
import {
  hasRuntimeDeclaration,
  multiRuntimeRootDiagnostics,
} from "./root-manifest-diagnostics.js";
import {
  pluginDeclarations,
  resolvePluginRuntimeManifest,
  validatePluginDeclarations,
} from "./declarations.js";

/**
 * Resolve a locale-aware PLUGIN.md path.
 *
 * Resolution order (e.g., locale = "ru-RU"):
 *   1. PLUGIN.ru-RU.md  (exact locale)
 *   2. PLUGIN.ru.md     (language only)
 *   3. PLUGIN.en-US.md / PLUGIN.en.md (English fallback)
 *   4. PLUGIN.md        (canonical fallback)
 *
 * The registered default locale and its explicit aliases use PLUGIN.md before
 * English so the historical canonical prompt remains unchanged for zh-CN.
 */
function localeVariantNames(locale: string): string[] {
  return localeLookupCandidates(locale).map(
    (candidate) => `PLUGIN.${candidate}.md`,
  );
}

function isDefaultLocaleOrAlias(locale: string): boolean {
  const defaultDefinition = localeRegistry.get(DEFAULT_LOCALE);
  if (normalizeLocale(locale) === normalizeLocale(DEFAULT_LOCALE)) return true;
  return (
    defaultDefinition?.aliases?.some(
      (alias) =>
        canonicalizeLocale(alias) !== undefined &&
        normalizeLocale(canonicalizeLocale(alias)!) === normalizeLocale(locale),
    ) ?? false
  );
}

async function resolveLocalizedPluginMd(
  dir: string,
  locale?: string,
): Promise<string> {
  const base = path.join(dir, "PLUGIN.md");
  const canonicalLocale = canonicalizeLocale(locale);
  if (!canonicalLocale) return base;

  const requestedNames = localeVariantNames(canonicalLocale);
  for (const name of requestedNames) {
    const candidate = path.join(dir, name);
    if (await fileExists(candidate)) return candidate;
  }

  if (isDefaultLocaleOrAlias(canonicalLocale)) return base;

  const fallbackLocale = canonicalizeLocale(DEFAULT_FALLBACK_LOCALE)!;
  for (const name of localeVariantNames(fallbackLocale)) {
    if (requestedNames.includes(name)) continue;
    const candidate = path.join(dir, name);
    if (await fileExists(candidate)) return candidate;
  }

  return base;
}

/**
 * Read + parse a plugin's PLUGIN.md for a locale.
 *
 * The prompt body comes from the locale variant (that is the point of having
 * one); the manifest is reconciled against the canonical PLUGIN.md so a
 * translation cannot change the runtime's execution contract — see
 * parsePluginMd's canonical-frontmatter reconciliation.
 */
async function parsePluginMdForLocale(
  dir: string,
  locale?: string,
): Promise<ParsedPluginMd> {
  const localizedPath = await resolveLocalizedPluginMd(dir, locale);
  const basePath = path.join(dir, "PLUGIN.md");
  const canonical = parsePluginMd(
    await fs.readFile(basePath, "utf-8"),
    basePath,
  );
  if (localizedPath === basePath) return canonical;

  return parsePluginMd(
    await fs.readFile(localizedPath, "utf-8"),
    localizedPath,
    canonical.rawFrontmatter,
  );
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
  definition?: PluginDefinition,
): Promise<PluginSummary> {
  const loaded = definition ?? (await loadPluginDefinition(discovery, locale));
  {
    const root = loaded.packageManifest;
    const data = root?.rawFrontmatter;
    const manifest = root?.manifest;
    const description = data?.description;
    return {
      id: discovery.id,
      name: manifest?.name ?? discovery.id,
      ...(manifest?.displayName ? { displayName: manifest.displayName } : {}),
      description:
        typeof description === "string" ||
        (description &&
          typeof description === "object" &&
          !Array.isArray(description))
          ? (description as PluginSummary["description"])
          : (manifest?.description ?? ""),
      pluginType: manifest?.pluginType ?? "plugin",
      runtimeCount: loaded.manifests.length,
      ...(manifest?.tags ? { tags: manifest.tags } : {}),
      ...(manifest?.relations ? { relations: manifest.relations } : {}),
    };
  }
}

/**
 * Level 1: Load full plugin manifest (all frontmatter fields).
 * Returns parsed PLUGIN.md for single-runtime, or all runtimes for multi-runtime.
 *
 * @param locale - Optional locale for loading localized PLUGIN.md
 */
export interface PluginDefinition {
  readonly packageManifest?: ParsedPluginMd;
  readonly manifests: readonly ParsedPluginMd[];
}

export async function loadPluginDefinition(
  discovery: PluginDiscoveryResult,
  locale?: string,
): Promise<PluginDefinition> {
  const rootPath = path.join(discovery.rootPath, "PLUGIN.md");
  const packageManifest = (await fileExists(rootPath))
    ? await parsePluginMdForLocale(discovery.rootPath, locale)
    : undefined;
  const manifests: ParsedPluginMd[] = [];
  if (discovery.isMultiRuntime) {
    if (packageManifest) {
      const diagnostics = multiRuntimeRootDiagnostics(packageManifest.manifest);
      if (diagnostics.length)
        throw new Error(
          `${rootPath}: ${diagnostics.map((d) => `${d.path}: ${d.message}`).join("; ")}`,
        );
    }
    for (const mdPath of discovery.pluginMdPaths) {
      const parsed = await parsePluginMdForLocale(path.dirname(mdPath), locale);
      if (hasRuntimeDeclaration(parsed.manifest)) manifests.push(parsed);
      else
        throw new Error(
          `${mdPath}: runtime declaration requires execution fields; move package-only declarations to the root PLUGIN.md`,
        );
    }
  } else if (
    packageManifest &&
    hasRuntimeDeclaration(packageManifest.manifest)
  ) {
    manifests.push(packageManifest);
  }
  const definition = {
    ...(packageManifest ? { packageManifest } : {}),
    manifests,
  };
  validatePluginDeclarations([
    ...(packageManifest ? [packageManifest] : []),
    ...manifests,
  ]);
  return definition;
}

export async function loadPluginManifest(
  discovery: PluginDiscoveryResult,
  locale?: string,
): Promise<readonly ParsedPluginMd[]> {
  return (await loadPluginDefinition(discovery, locale)).manifests;
}

/** Compile already parsed declarations without importing code or re-reading files. */
export async function loadPluginEntryDefinition(
  discovery: PluginDiscoveryResult,
  declarations: readonly ParsedPluginMd[],
): Promise<PluginEntryDefinition> {
  return {
    pluginId: discovery.id,
    pluginRoot: discovery.rootPath,
    entryPaths: [
      ...new Set(
        declarations.flatMap(({ manifest }) =>
          manifest.entry ? [manifest.entry] : [],
        ),
      ),
    ],
  };
}

/**
 * Resolve the directory for a given runtime name within a discovery result.
 */
async function resolveRuntimeDir(
  discovery: PluginDiscoveryResult,
  runtimeName: string,
  definition: PluginDefinition,
  includePackage = false,
): Promise<string> {
  const records = includePackage
    ? pluginDeclarations(definition)
    : definition.manifests;
  const record = records.find(({ manifest }) => manifest.name === runtimeName);
  if (!record?.sourcePath)
    throw new Error(
      `Runtime declaration "${runtimeName}" has no discovered source path`,
    );
  await assertInsideRoot(
    discovery.rootPath,
    record.sourcePath,
    "Runtime manifest",
  );
  return path.dirname(record.sourcePath);
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
        specs.push(await loadPluginUiSpec(pluginRoot, fullPath));
      } else {
        // Preserve unsupported declarations for per-spec API diagnostics.
        // The Web client does not dynamically load plugin component files.
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
    if (declaredPath === WORLD_IR_V1_SCHEMA_URI) {
      return WORLD_IR_V1_JSON_SCHEMA;
    }
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
  if (declaredPath === WORLD_IR_V1_SCHEMA_URI) {
    return WORLD_IR_V1_JSON_SCHEMA;
  }
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
  definition?: PluginDefinition,
): Promise<Pick<LoadedRuntime, "manifest" | "uiSpecs">> {
  const snapshot =
    definition ?? (await loadPluginDefinition(discovery, locale));
  const runtimeDir = await resolveRuntimeDir(
    discovery,
    runtimeName,
    snapshot,
    true,
  );
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
  definition?: PluginDefinition,
): Promise<LoadedRuntime> {
  const snapshot =
    definition ?? (await loadPluginDefinition(discovery, locale));
  const runtimeDir = await resolveRuntimeDir(discovery, runtimeName, snapshot);
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
    if (typeof mod.default !== "function") {
      throw new Error(
        `Handler module "${parsed.manifest.handler}" does not export a default function (got ${typeof mod.default})`,
      );
    }
    handler = mod.default as FunctionHandler;
  }

  // Load guard function for agent runtimes with pre-execution gate
  let guard: AgentGuard | undefined;
  if (parsed.manifest.guard) {
    const guardPath = path.resolve(runtimeDir, parsed.manifest.guard);
    await assertInsideRoot(discovery.rootPath, guardPath, "Guard");
    const mod = await import(pathToFileURL(guardPath).href);
    if (typeof mod.default !== "function") {
      throw new Error(
        `Guard module "${parsed.manifest.guard}" does not export a default function (got ${typeof mod.default})`,
      );
    }
    guard = mod.default as AgentGuard;
  }

  // Load UI spec files from ui/ directory
  const uiSpecs = await loadUiSpecs(
    runtimeDir,
    discovery.rootPath,
    parsed.manifest.ui,
  );

  return {
    manifest: resolvePluginRuntimeManifest(snapshot, parsed.manifest),
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
