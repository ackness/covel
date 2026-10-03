import { resolvePluginDeclarations } from "./declarations.js";
import { loadPluginUiSpec } from "./ui-spec.js";
/**
 * Progressive plugin loading — three levels of detail.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalizeLocale,
  hasIllegalDetachedContract,
  instructionVariantCandidates,
  isInstructionVariantLocale,
} from "@covel/shared";
import type { PluginManifest, RuntimeManifest } from "@covel/shared";
import type {
  PluginDiscoveryResult,
  PluginSummary,
  PluginEntryDefinition,
  LoadedRuntime,
  ParsedPluginMd,
  ParsedRuntimeMd,
  PackageManifest,
  FunctionHandler,
  AgentGuard,
} from "./types.js";
import {
  parsePluginMd,
  parseRuntimeMd,
  compileInlineRuntime,
} from "./parse-plugin-md.js";
import {
  resolvePluginRuntimeManifest,
  validatePluginDeclarations,
} from "./declarations.js";

/**
 * Prompt files for a session locale, most specific first.
 *
 * The canonical `PLUGIN.md` / `RUNTIME.md` is English and is the base every
 * plugin supplies. A Chinese session reads a `*.zh-CN.md` or `*.zh.md` variant
 * when the plugin ships one; every other locale reads the canonical file.
 * `COVEL_INSTRUCTION_LOCALE` can force either language for all sessions.
 */
function localizedMarkdownNames(locale?: string, stem = "PLUGIN"): string[] {
  return [
    ...instructionVariantCandidates(locale).map(
      (candidate) => `${stem}.${candidate}.md`,
    ),
    `${stem}.md`,
  ];
}

/** A variant file in a language that has no instruction set is never read. */
function warnUnreadVariant(sourcePath: string): void {
  console.warn(
    `[plugin-loader] ${sourcePath} is not read: prompt files exist only as the canonical English file and a Chinese (*.zh.md) variant. Translate labels with locale maps instead.`,
  );
}

async function resolveLocalizedPluginMd(
  dir: string,
  locale?: string,
  stem = "PLUGIN",
): Promise<string> {
  for (const name of localizedMarkdownNames(locale, stem)) {
    const candidate = path.join(dir, name);
    if (await fileExists(candidate)) return candidate;
  }
  return path.join(dir, `${stem}.md`);
}

/** Capture prose before publication; later locale selection never reads live files. */
async function captureRuntimePrompts(
  discovery: PluginDiscoveryResult,
  parsed: ParsedRuntimeMd,
  plugin: PluginManifest,
): Promise<ParsedRuntimeMd> {
  const dir = discovery.isMultiRuntime
    ? path.dirname(parsed.sourcePath!)
    : discovery.rootPath;
  const stem = discovery.isMultiRuntime ? "RUNTIME" : "PLUGIN";
  const basePath = path.join(dir, `${stem}.md`);
  const baseContent = await fs.readFile(basePath, "utf-8");
  const canonical = discovery.isMultiRuntime
    ? parseRuntimeMd(baseContent, basePath, plugin)
    : parsePluginMd(baseContent, basePath);
  const promptTemplates: Record<string, string> = {
    [`${stem}.md`]: canonical.promptTemplate,
  };
  for (const name of await fs.readdir(dir)) {
    if (
      !name.startsWith(`${stem}.`) ||
      !name.endsWith(".md") ||
      name === `${stem}.md`
    )
      continue;
    const variantLocale = canonicalizeLocale(name.slice(stem.length + 1, -3));
    if (!variantLocale) continue;
    const sourcePath = path.join(dir, name);
    if (!isInstructionVariantLocale(variantLocale)) {
      warnUnreadVariant(sourcePath);
      continue;
    }
    await assertInsideRoot(discovery.rootPath, sourcePath, "Localized prompt");
    const content = await fs.readFile(sourcePath, "utf-8");
    const localized = discovery.isMultiRuntime
      ? parseRuntimeMd(content, sourcePath, plugin, canonical.rawFrontmatter)
      : parsePluginMd(content, sourcePath, canonical.rawFrontmatter);
    promptTemplates[name] = localized.promptTemplate;
  }
  return { ...parsed, promptTemplates };
}

/** Select prose from an already captured definition without changing its contract. */
export function resolveRuntimePrompt(
  parsed: ParsedRuntimeMd,
  locale?: string,
): string {
  if (!parsed.promptTemplates) return parsed.promptTemplate;
  const stem = "RUNTIME.md" in parsed.promptTemplates ? "RUNTIME" : "PLUGIN";
  return (
    localizedMarkdownNames(locale, stem)
      .map((name) => parsed.promptTemplates![name])
      .find((body) => body !== undefined) ?? parsed.promptTemplate
  );
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
): Promise<ParsedPluginMd>;
async function parsePluginMdForLocale(
  dir: string,
  locale: string | undefined,
  plugin: PluginManifest,
): Promise<ParsedRuntimeMd>;
async function parsePluginMdForLocale(
  dir: string,
  locale?: string,
  plugin?: PluginManifest,
): Promise<ParsedPluginMd | ParsedRuntimeMd> {
  const stem = plugin ? "RUNTIME" : "PLUGIN";
  const localizedPath = await resolveLocalizedPluginMd(dir, locale, stem);
  const basePath = path.join(dir, `${stem}.md`);
  const parse = (
    content: string,
    file: string,
    canonical?: Readonly<Record<string, unknown>>,
  ) =>
    plugin
      ? parseRuntimeMd(content, file, plugin, canonical)
      : parsePluginMd(content, file, canonical);
  const canonical = parse(await fs.readFile(basePath, "utf-8"), basePath);
  return localizedPath === basePath
    ? canonical
    : parse(
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
  readonly packageManifest: ParsedPluginMd;
  readonly manifests: readonly ParsedRuntimeMd[];
}

export async function loadPluginDefinition(
  discovery: PluginDiscoveryResult,
  locale?: string,
): Promise<PluginDefinition> {
  const rootPath = path.join(discovery.rootPath, "PLUGIN.md");
  const parsedPackage = await parsePluginMdForLocale(
    discovery.rootPath,
    locale,
  );
  const contractSchemas: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [contract, declaration] of Object.entries(
    parsedPackage.plugin.contracts ?? {},
  )) {
    const schemaPath = path.resolve(discovery.rootPath, declaration.schema);
    await assertInsideRoot(discovery.rootPath, schemaPath, "Contract schema");
    contractSchemas[contract] = JSON.parse(
      await fs.readFile(schemaPath, "utf-8"),
    ) as Record<string, unknown>;
  }
  for (const [namespace, declaration] of Object.entries(
    parsedPackage.plugin.contributes?.data ?? {},
  )) {
    for (const contract of declaration.accepts ?? []) {
      const declared = parsedPackage.plugin.contracts?.[contract];
      if (
        !declared ||
        path.resolve(discovery.rootPath, declared.schema) !==
          path.resolve(discovery.rootPath, declaration.schema)
      )
        throw new Error(
          `${rootPath}: data namespace ${namespace} must use its accepted contract ${contract} schema`,
        );
    }
  }
  const packageManifest = { ...parsedPackage, contractSchemas };
  const plugin = packageManifest.plugin;
  if (plugin.id !== discovery.id)
    throw new Error(
      `${rootPath}: id must match plugin directory ${discovery.id}`,
    );
  if (discovery.isMultiRuntime && plugin.runtime)
    throw new Error(`${rootPath}: inline runtime and runtimes/ cannot coexist`);
  const manifests: ParsedRuntimeMd[] = [];
  if (discovery.isMultiRuntime) {
    for (const mdPath of discovery.pluginMdPaths)
      manifests.push(
        await parsePluginMdForLocale(path.dirname(mdPath), locale, plugin),
      );
  } else {
    const runtime = compileInlineRuntime(packageManifest);
    if (runtime) manifests.push(runtime);
  }
  const provided = new Set(
    (plugin.provides ?? []).map((p) =>
      typeof p === "string" ? p : p.contract,
    ),
  );
  const outputs = new Set<string>();
  for (const parsed of manifests) {
    const contract = parsed.runtime?.io?.output?.contract;
    if (!contract) continue;
    if (!provided.has(contract))
      throw new Error(
        `${parsed.sourcePath}: output contract ${contract} is not declared in root provides`,
      );
    if (outputs.has(contract))
      throw new Error(
        `${parsed.sourcePath}: ambiguous output contract ${contract}; only one runtime may provide it`,
      );
    outputs.add(contract);
  }
  const dependencies = new Set([
    ...(plugin.requires ?? []),
    ...(plugin.optional ?? []),
  ]);
  for (const parsed of manifests) {
    const runtimeReferences = [
      ...(["needs", "after"] as const).flatMap((field) =>
        (parsed.runtime?.schedule?.[field] ?? []).flatMap((reference, index) =>
          typeof reference === "string"
            ? [{ runtimeId: reference, field: `schedule.${field}[${index}]` }]
            : "runtime" in reference
              ? [
                  {
                    runtimeId: reference.runtime,
                    field: `schedule.${field}[${index}].runtime`,
                  },
                ]
              : [],
        ),
      ),
      ...Object.entries(parsed.runtime?.io?.inputs ?? {}).flatMap(
        ([name, input]) =>
          "runtime" in input.from
            ? [
                {
                  runtimeId: input.from.runtime,
                  field: `io.inputs.${name}.from.runtime`,
                },
              ]
            : [],
      ),
    ];
    // Cross-package named runtime references are rejected by design (see docs/reference/plugins.md).
    // Within-package references (pluginId/runtimeName) are permitted for internal coordination.
    // Cross-package dependencies must use the contract system for stable, versioned coupling.
    for (const { runtimeId, field } of runtimeReferences) {
      if (runtimeId !== plugin.id && !runtimeId.startsWith(`${plugin.id}/`))
        throw new Error(
          `${parsed.sourcePath}: ${field} references runtime ${runtimeId} outside package ${plugin.id}; use a contract for cross-package dependencies`,
        );
    }
    const references = [
      ...(parsed.runtime?.schedule?.needs ?? []).flatMap((need) =>
        typeof need === "object" && "contract" in need
          ? [{ contract: need.contract, field: "schedule.needs" }]
          : [],
      ),
      ...Object.entries(parsed.runtime?.io?.inputs ?? {}).flatMap(
        ([name, input]) =>
          "contract" in input.from
            ? [
                {
                  contract: input.from.contract,
                  field: `io.inputs.${name}.from.contract`,
                },
              ]
            : [],
      ),
    ];
    for (const { contract, field } of references) {
      if (!dependencies.has(contract))
        throw new Error(
          `${parsed.sourcePath}: ${field} contract ${contract} must be declared in root requires or optional`,
        );
    }
  }
  const definition = {
    packageManifest,
    manifests: await Promise.all(
      manifests.map((parsed) =>
        captureRuntimePrompts(discovery, parsed, plugin),
      ),
    ),
  };
  validatePluginDeclarations([packageManifest]);
  return definition;
}

export async function loadPluginManifest(
  discovery: PluginDiscoveryResult,
  locale?: string,
): Promise<readonly ParsedRuntimeMd[]> {
  return (await loadPluginDefinition(discovery, locale)).manifests;
}

/** Freeze entry metadata and root prompt translations before execution. */
export async function loadPluginEntryDefinition(
  discovery: PluginDiscoveryResult,
  declarations: readonly ParsedPluginMd[],
): Promise<PluginEntryDefinition> {
  const staticPromptVariants: Record<
    string,
    PluginEntryDefinition["staticPromptSegments"]
  > = {};
  for (const filename of await fs.readdir(discovery.rootPath)) {
    const match = /^PLUGIN\.(.+)\.md$/.exec(filename);
    const locale = match && canonicalizeLocale(match[1]);
    // Unread variants were already reported while capturing runtime prompts.
    if (!locale || !isInstructionVariantLocale(locale)) continue;
    const file = path.join(discovery.rootPath, filename);
    await assertInsideRoot(
      discovery.rootPath,
      file,
      "Localized plugin manifest",
    );
    const localized = await parsePluginMdForLocale(discovery.rootPath, locale);
    staticPromptVariants[locale] = localized.plugin.contributes?.prompt ?? [];
  }
  return {
    staticPromptVariants,
    contributions: declarations[0]?.plugin.contributes ?? {},
    staticPromptSegments: declarations[0]?.plugin.contributes?.prompt ?? [],
    extensions: resolvePluginDeclarations(declarations).extensions,
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
): Promise<string> {
  const records = definition.manifests;
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
  pluginId: string,
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
        specs.push(await loadPluginUiSpec(pluginRoot, fullPath, pluginId));
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
  contracts: ContractSchemas,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (declaredPath) {
    if (declaredPath.startsWith("contract:"))
      return requireContractSchema(declaredPath, contracts);
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
  contracts: ContractSchemas,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (declaredPath.startsWith("contract:"))
    return requireContractSchema(declaredPath, contracts);
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
  contracts: ContractSchemas,
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
      contracts,
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
  contracts: ContractSchemas,
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
      contracts,
    );
    if (schema) out[decl.name] = schema;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Load the package declaration and its UI specs — no handler / guard
 * imports. UI specs are data (JSON files, or a recorded component path), so
 * this path never executes plugin JS and is safe for untrusted (community)
 * plugins whose code must not run before approval.
 */
export async function loadPluginUi(
  discovery: PluginDiscoveryResult,
  locale?: string,
  definition?: PluginDefinition,
): Promise<{
  readonly manifest: PackageManifest;
  readonly uiSpecs: LoadedRuntime["uiSpecs"];
}> {
  const snapshot =
    definition ?? (await loadPluginDefinition(discovery, locale));
  const manifest = snapshot.packageManifest.manifest;
  const uiSpecs = await loadUiSpecs(
    discovery.rootPath,
    discovery.rootPath,
    discovery.id,
    manifest.ui,
  );
  return { manifest, uiSpecs };
}

/**
 * Level 2: Fully load a runtime for execution.
 * Reads prompt template, output schema.
 *
 * @param locale - Optional session locale; a Chinese locale reads the PLUGIN.zh.md variant
 */
export async function loadRuntime(
  discovery: PluginDiscoveryResult,
  runtimeName: string,
  locale?: string,
  definition?: PluginDefinition,
  resolvedContracts: ContractSchemas = {},
  generation?: string,
): Promise<LoadedRuntime> {
  const snapshot =
    definition ?? (await loadPluginDefinition(discovery, locale));
  const runtimeDir = await resolveRuntimeDir(discovery, runtimeName, snapshot);
  const contracts = {
    ...resolvedContracts,
    ...snapshot.packageManifest?.contractSchemas,
  };
  const parsed = snapshot.manifests.find(
    (record) => record.manifest.name === runtimeName,
  )!;

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
    contracts,
  );
  const outputContractSchema = parsed.manifest.outputContract
    ? contracts[parsed.manifest.outputContract]
    : undefined;

  const inputSchema = parsed.manifest.input?.schema
    ? await loadDeclaredSchema(
        runtimeDir,
        discovery.rootPath,
        parsed.manifest.input.schema,
        "input schema",
        contracts,
      )
    : undefined;

  const bindingAcceptsSchemas = await loadBindingAcceptsSchemas(
    runtimeDir,
    discovery.rootPath,
    parsed.manifest.inputs,
    contracts,
  );

  const bindingContractSchemas = Object.fromEntries(
    Object.entries(parsed.manifest.inputs ?? {}).flatMap(([name, binding]) => {
      const schema =
        "capability" in binding.from
          ? contracts[binding.from.capability]
          : undefined;
      return schema ? [[name, schema]] : [];
    }),
  );

  const exportAcceptsSchemas = await loadExportAcceptsSchemas(
    runtimeDir,
    discovery.rootPath,
    parsed.manifest.input?.inject,
    contracts,
  );
  const exportContractSchemas = Object.fromEntries(
    (parsed.manifest.input?.inject ?? []).flatMap((binding) => {
      if (binding.kind !== "runtime-export" || !("capability" in binding.from))
        return [];
      const schema = contracts[binding.from.capability];
      return schema ? [[binding.name, schema]] : [];
    }),
  );

  // Load function handler for runtimeType: 'function'
  let handler: FunctionHandler | undefined;
  if (parsed.manifest.runtimeType === "function" && parsed.manifest.handler) {
    const handlerPath = path.resolve(runtimeDir, parsed.manifest.handler);
    await assertInsideRoot(discovery.rootPath, handlerPath, "Handler");
    const url = pathToFileURL(handlerPath);
    if (generation) url.searchParams.set("generation", generation);
    const mod = await import(url.href);
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
    const url = pathToFileURL(guardPath);
    if (generation) url.searchParams.set("generation", generation);
    const mod = await import(url.href);
    if (typeof mod.default !== "function") {
      throw new Error(
        `Guard module "${parsed.manifest.guard}" does not export a default function (got ${typeof mod.default})`,
      );
    }
    guard = mod.default as AgentGuard;
  }

  return {
    manifest: resolvePluginRuntimeManifest(snapshot, parsed.manifest),
    promptTemplate: resolveRuntimePrompt(parsed, locale),
    outputSchema,
    ...(outputContractSchema ? { outputContractSchema } : {}),
    ...(inputSchema ? { inputSchema } : {}),
    ...(bindingAcceptsSchemas ? { bindingAcceptsSchemas } : {}),
    ...(Object.keys(bindingContractSchemas).length
      ? { bindingContractSchemas }
      : {}),
    ...(exportAcceptsSchemas ? { exportAcceptsSchemas } : {}),
    ...(Object.keys(exportContractSchemas).length
      ? { exportContractSchemas }
      : {}),
    handler,
    guard,
  };
}

type ContractSchemas = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;
function requireContractSchema(
  uri: string,
  contracts: ContractSchemas,
): Readonly<Record<string, unknown>> {
  const schema = contracts[uri.slice("contract:".length)];
  if (!schema) throw new Error(`Unresolved schema contract: ${uri}`);
  return schema;
}
