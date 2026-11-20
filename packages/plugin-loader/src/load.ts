import {
  frameworkContractSchemas,
  defaultOutputSchemaContract,
} from "@covel/shared/contracts";
import {
  assertDataContractSchemaPaths,
  packageContractSchemaPath,
  resolvePackageContractSchema,
} from "./package-contracts.js";
import { datasetKeyIssue, datasetSchemaIssues } from "./dataset-rules.js";
import {
  actionKindDeclarationIssues,
  actionKindSchemaField,
  compileActionKinds,
  isSchemaObject,
} from "./action-kinds.js";
import { assertInsideRoot } from "./path-containment.js";
import { fileExists } from "./file-system.js";
import { assertRuntimeOutputSchema } from "./runtime-output-schema.js";
import {
  PackageInventoryError,
  packageFileSignature,
  readPackageInventory,
} from "./package-inventory.js";
import {
  assessPluginExecution,
  unknownExecutionAssessment,
  type PluginExecutionProof,
} from "./execution-assessment.js";
import { provideHostModules } from "./host-modules.js";
import { validateRuntimeDeclarations } from "./static-validation.js";
import { readMessageCatalogs } from "./locale-messages.js";
import { pluginLanguages } from "./plugin-languages.js";
import { readManifestLabels, type ManifestLabels } from "./locale-labels.js";
import {
  missingDefaultHandler,
  surplusStoryRuntimes,
  withDerivedPackageFields,
  type PackageFileExists,
} from "./package-defaults.js";
/**
 * Progressive plugin loading — three levels of detail.
 */

import fs from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalizeLocale,
  hasIllegalDetachedContract,
  instructionVariantCandidates,
  isInstructionVariantLocale,
} from "@covel/shared";
import type {
  PluginManifest,
  PluginLanguages,
  PluginMessageCatalog,
  RuntimeBinding,
} from "@covel/shared";
import type {
  DisabledRuntime,
  IgnoredField,
  PluginDiscoveryResult,
  PluginSummary,
  PluginEntryDefinition,
  LoadedRuntime,
  ParsedPluginMd,
  ParsedRuntimeMd,
  FunctionHandler,
  AgentGuard,
} from "./types.js";
import {
  parsePluginMd,
  parseRuntimeMd,
  compileInlineRuntime,
  RuntimeDisabledError,
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
    await assertInsideRoot(
      discovery.rootPath,
      sourcePath,
      "Localized prompt path traversal rejected",
    );
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
    labels?: readonly ManifestLabels[],
  ) =>
    plugin
      ? parseRuntimeMd(content, file, plugin, canonical, labels)
      : parsePluginMd(content, file, canonical, labels);
  // The plugin root is the directory itself, or two levels above a runtime's.
  const pluginRoot = plugin ? path.resolve(dir, "..", "..") : dir;
  const labels = await readManifestLabels(
    pluginRoot,
    path.relative(pluginRoot, basePath),
  );
  const canonical = parse(
    await fs.readFile(basePath, "utf-8"),
    basePath,
    undefined,
    labels,
  );
  if (localizedPath === basePath) return canonical;
  const localized = parse(
    await fs.readFile(localizedPath, "utf-8"),
    localizedPath,
    canonical.rawFrontmatter,
  );
  // The variant inherits the canonical fields; an unknown one is reported
  // where the author wrote it.
  const { ignoredFields: _variant, ...rest } = localized;
  return canonical.ignoredFields
    ? { ...rest, ignoredFields: canonical.ignoredFields }
    : rest;
}

/** Whether a file exists under the package root, read synchronously. */
function packageFileExists(rootPath: string): PackageFileExists {
  return (relativePath) => {
    try {
      return statSync(path.join(rootPath, relativePath)).isFile();
    } catch {
      return false;
    }
  };
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
      kind: manifest?.kind ?? "plugin",
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
  readonly executionAssessment?: PluginExecutionProof;
  readonly packageManifest: ParsedPluginMd;
  readonly manifests: readonly ParsedRuntimeMd[];
  /** The `messages` section of each `locales/<locale>.yaml`. */
  readonly messages: readonly PluginMessageCatalog[];
  /** The languages the package has text in. */
  readonly languages: PluginLanguages;
  /**
   * Runtimes left out because their manifest can never run. The rest of the
   * package loads; `pnpm validate:plugin` reports each one as an error.
   */
  readonly disabledRuntimes: readonly DisabledRuntime[];
  /**
   * Unknown whole fields left out of the manifests. The package loads
   * without them; `pnpm validate:plugin` reports each one as an error.
   */
  readonly ignoredFields: readonly IgnoredField[];
}

/**
 * The package without what its left-out runtimes would have provided, so
 * session plugin selection never counts on an output that cannot appear.
 */
function withoutDisabledOutputs(
  parsed: ParsedPluginMd,
  disabled: readonly DisabledRuntime[],
): ParsedPluginMd {
  const contracts = new Set(
    disabled.flatMap(({ outputContract }) =>
      outputContract ? [outputContract] : [],
    ),
  );
  const provides = parsed.plugin.provides;
  if (!contracts.size || !provides) return parsed;
  return {
    ...parsed,
    plugin: {
      ...parsed.plugin,
      provides: provides.filter(
        (entry) =>
          !contracts.has(typeof entry === "string" ? entry : entry.contract),
      ),
    },
  };
}

async function readSchemaFile(
  filePath: string,
  field: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new Error(
      `${filePath}: ${field}: ${error instanceof Error ? error.message : String(error)}; provide valid JSON at the declared path`,
    );
  }
}

export async function loadPluginDefinition(
  discovery: PluginDiscoveryResult,
  locale?: string,
): Promise<PluginDefinition> {
  if (discovery.layoutError) throw new Error(discovery.layoutError);
  let inventoryFailure: { message: string; file?: string } | undefined;
  const inventory = await readPackageInventory(discovery.rootPath).catch(
    (error: unknown) => {
      if (error instanceof PackageInventoryError)
        inventoryFailure = {
          message: error.message,
          ...(error.file ? { file: error.file } : {}),
        };
      return undefined;
    },
  );
  for (const warning of discovery.layoutWarnings ?? [])
    console.warn(`[plugin-loader] ${warning}`);
  const rootPath = path.join(discovery.rootPath, "PLUGIN.md");
  const parsedPackage = await parsePluginMdForLocale(
    discovery.rootPath,
    locale,
  );
  const contractSchemas: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [contract, declaration] of Object.entries(
    parsedPackage.plugin.contracts ?? {},
  )) {
    const schemaPath = path.resolve(
      discovery.rootPath,
      packageContractSchemaPath(rootPath, contract, declaration.schema),
    );
    await assertInsideRoot(
      discovery.rootPath,
      schemaPath,
      "Contract schema path traversal rejected",
    );
    const declaredSchema = await readSchemaFile(
      schemaPath,
      `contracts.${contract}.schema`,
    );
    contractSchemas[contract] = resolvePackageContractSchema(
      rootPath,
      contract,
      declaredSchema,
    );
  }
  assertDataContractSchemaPaths(parsedPackage, rootPath);
  const datasetSchemas: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [name, declaration] of Object.entries(
    parsedPackage.plugin.contributes?.datasets ?? {},
  )) {
    const schemaPath = path.resolve(discovery.rootPath, declaration.schema);
    await assertInsideRoot(
      discovery.rootPath,
      schemaPath,
      "Dataset schema path traversal rejected",
    );
    const document = await readSchemaFile(
      schemaPath,
      `contributes.datasets.${name}.schema`,
    );
    const keyIssue = datasetKeyIssue(rootPath, name, declaration, document);
    if (keyIssue) throw new Error(keyIssue);
    datasetSchemas[name] = document;
  }
  const [schemaIssue] = datasetSchemaIssues(
    rootPath,
    discovery.rootPath,
    parsedPackage.plugin.contributes,
  );
  if (schemaIssue) throw new Error(schemaIssue);
  const actionKindDeclarations = parsedPackage.plugin.contributes?.actionKinds;
  const [actionKindIssue] = actionKindDeclarationIssues(
    rootPath,
    actionKindDeclarations,
  );
  if (actionKindIssue) throw new Error(actionKindIssue);
  const actionKindSchemas: Record<
    string,
    Readonly<Record<string, unknown>>
  > = {};
  for (const [index, declaration] of (actionKindDeclarations ?? []).entries()) {
    if (!declaration.schema) continue;
    const field = actionKindSchemaField(index);
    const schemaPath = path.resolve(discovery.rootPath, declaration.schema);
    await assertInsideRoot(
      discovery.rootPath,
      schemaPath,
      "Action kind schema path traversal rejected",
    );
    const document = await readSchemaFile(schemaPath, field);
    if (!isSchemaObject(document))
      throw new Error(
        `${rootPath}: ${field}: ${declaration.schema} must hold a JSON Schema object`,
      );
    actionKindSchemas[declaration.name] = document;
  }
  if (parsedPackage.plugin.id !== discovery.id)
    throw new Error(
      `${rootPath}: id must match plugin directory ${discovery.id}`,
    );
  if (
    discovery.isMultiRuntime &&
    (parsedPackage.plugin.runtime || parsedPackage.disabledRuntime)
  )
    throw new Error(`${rootPath}: inline runtime and runtimes/ cannot coexist`);
  const disabledRuntimes: DisabledRuntime[] = parsedPackage.disabledRuntime
    ? [parsedPackage.disabledRuntime]
    : [];
  const manifests: ParsedRuntimeMd[] = [];
  if (discovery.isMultiRuntime) {
    for (const mdPath of discovery.pluginMdPaths)
      try {
        manifests.push(
          await parsePluginMdForLocale(
            path.dirname(mdPath),
            locale,
            parsedPackage.plugin,
          ),
        );
      } catch (error) {
        if (!(error instanceof RuntimeDisabledError)) throw error;
        disabledRuntimes.push(error.disabled);
      }
  } else {
    try {
      const runtime = compileInlineRuntime(parsedPackage);
      if (runtime) manifests.push(runtime);
    } catch (error) {
      if (!(error instanceof RuntimeDisabledError)) throw error;
      disabledRuntimes.push(error.disabled);
    }
  }
  const exists = packageFileExists(discovery.rootPath);
  for (const parsed of [...manifests]) {
    const disabled = missingDefaultHandler(discovery.rootPath, parsed, exists);
    if (!disabled) continue;
    disabledRuntimes.push(disabled);
    manifests.splice(manifests.indexOf(parsed), 1);
  }
  for (const { parsed, disabled } of surplusStoryRuntimes(manifests)) {
    disabledRuntimes.push(disabled);
    manifests.splice(manifests.indexOf(parsed), 1);
  }
  for (const disabled of disabledRuntimes)
    console.warn(`[plugin-loader] ${disabled.message}`);
  const ignoredFields = [parsedPackage, ...manifests].flatMap(
    (parsed) => parsed.ignoredFields ?? [],
  );
  for (const ignored of ignoredFields)
    console.warn(
      `[plugin-loader] ${ignored.message}; this host does not know it and loads the package without it`,
    );
  const packageManifest = {
    ...withDerivedPackageFields(
      withoutDisabledOutputs(parsedPackage, disabledRuntimes),
      manifests,
      exists,
    ),
    contractSchemas,
    datasetSchemas,
    actionKinds: compileActionKinds(
      parsedPackage.plugin.id,
      actionKindDeclarations,
      actionKindSchemas,
    ),
  };
  const plugin = packageManifest.plugin;
  validateRuntimeDeclarations(packageManifest, manifests);
  const definition = {
    packageManifest,
    manifests: await Promise.all(
      manifests.map((parsed) =>
        captureRuntimePrompts(discovery, parsed, plugin),
      ),
    ),
    messages: await readMessageCatalogs(discovery.rootPath),
    languages: await pluginLanguages(discovery.rootPath),
    disabledRuntimes,
    ignoredFields,
  };
  validatePluginDeclarations(packageManifest);
  const stable =
    inventory &&
    inventory.signature ===
      (await packageFileSignature(discovery.rootPath).catch(() => undefined));
  return {
    ...definition,
    executionAssessment: stable
      ? {
          ...assessPluginExecution({
            files: inventory.files,
            directories: inventory.directories,
            root: packageManifest,
            runtimes: manifests,
          }),
          signature: inventory.signature,
          digest: inventory.digest,
        }
      : unknownExecutionAssessment(inventoryFailure),
  };
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
  root: ParsedPluginMd | undefined,
  runtimes: readonly ParsedRuntimeMd[],
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
      "Localized plugin manifest path traversal rejected",
    );
    const localized = await parsePluginMdForLocale(discovery.rootPath, locale);
    staticPromptVariants[locale] = localized.plugin.contributes?.prompt ?? [];
  }
  return {
    staticPromptVariants,
    contributions: root?.plugin.contributes ?? {},
    staticPromptSegments: root?.plugin.contributes?.prompt ?? [],
    extensions: root?.manifest.extensions ?? [],
    pluginId: discovery.id,
    pluginRoot: discovery.rootPath,
    entryPath: root?.plugin.entry || undefined,
    httpPermissions: [
      ...(root?.plugin.permissions?.http ?? []),
      ...runtimes.flatMap(({ manifest }) => manifest.permissions?.http ?? []),
    ],
  };
}

/**
 * Load a runtime's output JSON Schema.
 *
 * When `manifest.output.schema` declares a path, that exact file is loaded
 * (resolved against the runtime dir, containment-checked against the plugin
 * root); a declared-but-missing file rejects this runtime. With no declaration, fall back to the
 * `output.schema.json` convention — silently absent when the file is not there.
 */
async function loadOutputSchema(
  runtimeDir: string,
  pluginRoot: string,
  declaredPath: string | undefined,
  contracts: ContractSchemas,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const field = "io.output.schema";
  const containmentError = "Output schema path traversal rejected";
  if (declaredPath)
    return loadDeclaredSchema(
      runtimeDir,
      pluginRoot,
      declaredPath,
      field,
      contracts,
      containmentError,
    );

  const conventionPath = path.join(runtimeDir, "output.schema.json");
  if (!(await fileExists(conventionPath))) return undefined;
  await assertInsideRoot(pluginRoot, conventionPath, containmentError);
  return readSchemaFile(conventionPath, field);
}

/** Load a declared contract or runtime-dir-relative JSON Schema. */
async function loadDeclaredSchema(
  runtimeDir: string,
  pluginRoot: string,
  declaredPath: string,
  label: string,
  contracts: ContractSchemas,
  containmentError = `${label} path traversal rejected`,
): Promise<Readonly<Record<string, unknown>>> {
  if (declaredPath.startsWith("contract:"))
    return requireContractSchema(declaredPath, contracts);
  const fullPath = path.resolve(runtimeDir, declaredPath);
  await assertInsideRoot(pluginRoot, fullPath, containmentError);
  if (!(await fileExists(fullPath))) {
    throw new Error(
      `${fullPath}: ${label}: file not found; include the declared JSON Schema`,
    );
  }
  return readSchemaFile(fullPath, label);
}

/**
 * Resolve the consumer's accepts schema separately from the public contract.
 * Missing accepts contracts are recorded for optional bindings so the runtime
 * can withhold values it cannot validate; required bindings fail to load.
 */
async function loadBindingSchemas(
  runtimeDir: string,
  pluginRoot: string,
  bindings: readonly (readonly [string, RuntimeBinding])[],
  label: "binding" | "export",
  contracts: ContractSchemas,
  unresolved: string[],
) {
  const acceptsSchemas: Record<string, Readonly<Record<string, unknown>>> = {};
  const contractSchemas: [string, Readonly<Record<string, unknown>>][] = [];
  for (const [name, binding] of bindings) {
    if ("capability" in binding.from) {
      const schema = contracts[binding.from.capability];
      if (schema) contractSchemas.push([name, schema]);
    }
    const { accepts } = binding;
    if (!accepts) continue;
    if (
      binding.required === false &&
      accepts.startsWith("contract:") &&
      !contracts[accepts.slice("contract:".length)]
    ) {
      unresolved.push(name);
      continue;
    }
    const schema = await loadDeclaredSchema(
      runtimeDir,
      pluginRoot,
      accepts,
      `${label} accepts schema (${name})`,
      contracts,
    );
    if (schema) acceptsSchemas[name] = schema;
  }
  return {
    accepts: Object.keys(acceptsSchemas).length ? acceptsSchemas : undefined,
    contracts: contractSchemas.length
      ? Object.fromEntries(contractSchemas)
      : undefined,
  };
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
  authorizeCode?: () => Promise<boolean>,
): Promise<LoadedRuntime> {
  const snapshot =
    definition ?? (await loadPluginDefinition(discovery, locale));
  const parsed = snapshot.manifests.find(
    (record) => record.manifest.name === runtimeName,
  );
  if (!parsed?.sourcePath)
    throw new Error(
      `Runtime declaration "${runtimeName}" has no discovered source path`,
    );
  await assertInsideRoot(
    discovery.rootPath,
    parsed.sourcePath,
    "Runtime manifest path traversal rejected",
  );
  const runtimeDir = path.dirname(parsed.sourcePath);
  const contracts = {
    ...resolvedContracts,
    ...snapshot.packageManifest?.contractSchemas,
    ...frameworkContractSchemas,
  };
  // Deterministic loader rejection: a recurrently-detached spec that
  // still declares turn bindings can never satisfy them.
  if (hasIllegalDetachedContract(parsed.manifest)) {
    throw new Error(
      `Runtime "${parsed.manifest.name}" is always-detached (event/manual + background) ` +
        `but declares turn bindings (inputs) — no activation can satisfy them.`,
    );
  }

  const loadedOutputSchema = await loadOutputSchema(
    runtimeDir,
    discovery.rootPath,
    parsed.manifest.output?.schema,
    contracts,
  );
  // A framework contract the runtime provides is its output schema unless
  // the runtime declares a narrower one (never a function story's: the
  // kernel normalizes its return value into the story shape afterwards).
  const frameworkContract = defaultOutputSchemaContract(parsed.manifest);
  const outputSchema =
    loadedOutputSchema === undefined && frameworkContract
      ? requireContractSchema(`contract:${frameworkContract}`, contracts)
      : loadedOutputSchema;
  const outputContractSchema = parsed.manifest.outputContract
    ? contracts[parsed.manifest.outputContract]
    : undefined;

  const effectiveSchema =
    outputSchema !== undefined ? outputSchema : outputContractSchema;
  if (
    parsed.manifest.runtimeType !== "function" &&
    parsed.manifest.output?.from &&
    effectiveSchema === undefined
  )
    throw new Error(
      `${parsed.sourcePath}: io.output.from requires a loaded output schema or contract`,
    );
  assertRuntimeOutputSchema(
    parsed.manifest,
    parsed.sourcePath,
    effectiveSchema,
  );

  const inputSchema = parsed.manifest.input?.schema
    ? await loadDeclaredSchema(
        runtimeDir,
        discovery.rootPath,
        parsed.manifest.input.schema,
        "input schema",
        contracts,
      )
    : undefined;

  const unresolvedAccepts: string[] = [];
  const { accepts: bindingAcceptsSchemas, contracts: bindingContractSchemas } =
    await loadBindingSchemas(
      runtimeDir,
      discovery.rootPath,
      Object.entries(parsed.manifest.inputs ?? {}),
      "binding",
      contracts,
      unresolvedAccepts,
    );
  const { accepts: exportAcceptsSchemas, contracts: exportContractSchemas } =
    await loadBindingSchemas(
      runtimeDir,
      discovery.rootPath,
      (parsed.manifest.input?.inject ?? []).flatMap((binding) =>
        binding.kind === "runtime-export" ? [[binding.name, binding]] : [],
      ),
      "export",
      contracts,
      unresolvedAccepts,
    );

  async function loadRuntimeFunction(
    modulePath: string,
    label: "Handler" | "Guard",
  ) {
    const fullPath = path.resolve(runtimeDir, modulePath);
    await assertInsideRoot(
      discovery.rootPath,
      fullPath,
      `${label} path traversal rejected`,
    );
    if (authorizeCode && !(await authorizeCode()))
      throw new Error(
        `Runtime ${label.toLowerCase()} requires server-code and runtime authorization`,
      );
    provideHostModules(discovery.rootPath);
    const url = pathToFileURL(fullPath);
    if (generation) url.searchParams.set("generation", generation);
    const mod: { readonly default?: unknown } = await import(url.href);
    if (typeof mod.default !== "function") {
      throw new Error(
        `${label} module "${modulePath}" does not export a default function (got ${typeof mod.default})`,
      );
    }
    // Do not let the async return await a function's own `then` property.
    return { callable: mod.default };
  }

  // Load function handler for runtimeType: 'function'
  let handler: FunctionHandler | undefined;
  if (parsed.manifest.runtimeType === "function" && parsed.manifest.handler) {
    const { callable } = await loadRuntimeFunction(
      parsed.manifest.handler,
      "Handler",
    );
    handler = callable as FunctionHandler;
  }

  // Load guard function for agent runtimes with pre-execution gate
  let guard: AgentGuard | undefined;
  if (parsed.manifest.guard) {
    const { callable } = await loadRuntimeFunction(
      parsed.manifest.guard,
      "Guard",
    );
    guard = callable as AgentGuard;
  }

  const datasetSchemas = snapshot.packageManifest?.datasetSchemas;

  return {
    manifest: resolvePluginRuntimeManifest(snapshot, parsed.manifest),
    executionMode: snapshot.executionAssessment?.mode ?? "unknown",
    promptTemplate: resolveRuntimePrompt(parsed, locale),
    outputSchema,
    ...(outputContractSchema ? { outputContractSchema } : {}),
    ...(inputSchema ? { inputSchema } : {}),
    ...(bindingAcceptsSchemas ? { bindingAcceptsSchemas } : {}),
    ...(bindingContractSchemas ? { bindingContractSchemas } : {}),
    ...(exportAcceptsSchemas ? { exportAcceptsSchemas } : {}),
    ...(unresolvedAccepts.length > 0 ? { unresolvedAccepts } : {}),
    ...(exportContractSchemas ? { exportContractSchemas } : {}),
    // Shared, not copied: the commit's Ajv cache keys on schema identity.
    ...(datasetSchemas && Object.keys(datasetSchemas).length > 0
      ? { datasetSchemas }
      : {}),
    ...(snapshot.messages.length > 0 ? { messages: snapshot.messages } : {}),
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
