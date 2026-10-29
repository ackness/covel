export { loadPluginUiSpec, loadPluginUiSpecs } from "./ui-spec.js";
export type { PluginUiSpecDiagnostic, PluginUiSpecs } from "./ui-spec.js";
// ── Parsers ──────────────────────────────────────────────────────
export {
  parsePluginMd,
  parseRuntimeMd,
  compileInlineRuntime,
  normalizePackageManifest,
  RuntimeDisabledError,
} from "./parse-plugin-md.js";

// ── Discovery & Loading ──────────────────────────────────────────
export {
  discoverPluginAt,
  discoverPlugins,
  discoverPluginsMulti,
} from "./discover.js";
export { readPlainYamlFrontmatter } from "./plain-yaml-frontmatter.js";
export { runtimeDirectoryDiagnostics } from "./runtime-directory.js";
export {
  loadPluginSummary,
  loadPluginManifest,
  loadPluginDefinition,
  loadPluginEntryDefinition,
  loadRuntime,
  resolveRuntimePrompt,
} from "./load.js";
export {
  reloadGenerationUrl,
  trackReloadGeneration,
} from "./reload-generation.js";
export {
  HOST_MODULE_PARENT_URL,
  HOST_MODULES,
  isHostModule,
  provideHostModules,
} from "./host-modules.js";
export type { PluginDefinition } from "./load.js";
export {
  compileManifestLabels,
  validatePluginLabels,
} from "./locale-labels.js";
export { parseLocaleFile } from "./locale-files.js";
export { readMessageCatalogs } from "./locale-messages.js";
export {
  lockPluginLabels,
  pluginLabelUnits,
  pluginLocales,
  pluginTranslationStatus,
  writePluginTranslations,
} from "./locale-tooling.js";
export type { LabelUnit, PluginTranslationStatus } from "./locale-tooling.js";
export { setTranslationsDirectory } from "./locale-files.js";
export {
  describePluginLanguages,
  pluginLanguages,
} from "./plugin-languages.js";
export {
  pluginDeclarations,
  pluginRuntimeManifests,
  resolvePluginDeclarations,
  resolvePluginRuntimeManifest,
  validatePluginDeclarations,
} from "./declarations.js";
export { multiRuntimeRootDiagnostics } from "./root-manifest-diagnostics.js";
export {
  isDerivedTag,
  missingDefaultHandler,
  packageProvides,
  packageTags,
  withDerivedPackageFields,
  type PackageFileExists,
} from "./package-defaults.js";

// ── Registry ─────────────────────────────────────────────────────
export { normalizeRuntimeManifest, getRuntimeSpec } from "@covel/shared";

export { createPluginRegistry } from "./registry.js";
export type { PluginRegistry, PluginRegistryOptions } from "./registry.js";

// ── Trust ────────────────────────────────────────────────────────
export { getPluginTrustInfo, deriveBuiltinPluginIds } from "./trust.js";

// ── Types ────────────────────────────────────────────────────────
export type {
  DisabledRuntime,
  IgnoredField,
  ParsedPluginMd,
  ParsedRuntimeMd,
  PackageManifest,
  PluginDiscoveryResult,
  PluginEntryDefinition,
  PluginSummary,
  LoadedRuntime,
  PluginEntryStatus,
  PluginRegistryEntry,
  RegistryChangeEvent,
  PluginSource,
  PluginTrustInfo,
  FunctionHandler,
  AgentGuard,
  AgentGuardResult,
  FunctionHandlerContext,
  PluginRuntimeGateway,
  PluginRuntimeUtils,
  AssetProgressInput,
  ResolvedSlotForPlugin,
  PluginDataWriter,
  PluginLogger,
  ProgressReporter,
  ProgressEffect,
  FunctionStoreView,
  ImagesContext,
  ImageGenerateInput,
  ImageGenerateOutput,
  SpeechContext,
  SpeechGenerateInput,
  SpeechGenerateOutput,
  SpeechTranscribeInput,
  MusicContext,
  MusicGenerateInput,
  MusicGenerateOutput,
} from "./types.js";

export { resolveRuntimeProviders } from "./runtime-providers.js";
export { contractReferenceDiagnostics } from "./contract-diagnostics.js";

export { compileRuntimeManifest } from "./compile-manifest.js";

export {
  packageModuleTypeProblem,
  pluginImportReferences,
  validatePluginFiles,
  validateRuntimeDeclarations,
} from "./static-validation.js";

export { isPathInside, assertInsideRoot } from "./path-containment.js";

export {
  validatePluginPackage,
  parseIssueLocation,
  redactPaths,
  type PluginPackageValidation,
} from "./package-validation.js";

export {
  computePluginCapabilities,
  packageHasServerCode,
} from "./capabilities.js";
