export { loadPluginUiSpec } from "./ui-spec.js";
// ── Parsers ──────────────────────────────────────────────────────
export { parsePluginMd } from "./parse-plugin-md.js";

// ── Discovery & Loading ──────────────────────────────────────────
export { discoverPlugins, discoverPluginsMulti } from "./discover.js";
export {
  loadPluginSummary,
  loadPluginManifest,
  loadPluginDefinition,
  loadPluginEntryDefinition,
  loadRuntime,
  loadRuntimeUi,
} from "./load.js";
export type { PluginDefinition } from "./load.js";
export {
  pluginDeclarations,
  pluginRuntimeManifests,
  resolvePluginDeclarations,
  resolvePluginRuntimeManifest,
  validatePluginDeclarations,
} from "./declarations.js";
export {
  hasRuntimeDeclaration,
  multiRuntimeRootDiagnostics,
} from "./root-manifest-diagnostics.js";

// ── Registry ─────────────────────────────────────────────────────
export { normalizeRuntimeManifest, getRuntimeSpec } from "./normalize.js";

export { createPluginRegistry } from "./registry.js";
export type { PluginRegistry, PluginRegistryOptions } from "./registry.js";

// ── Trust ────────────────────────────────────────────────────────
export { getPluginTrustInfo, deriveBuiltinPluginIds } from "./trust.js";

// ── Plugin LLM Config ────────────────────────────────────────────
export {
  loadPluginLlmConfig,
  parsePluginLlmToml,
} from "./plugin-llm-config.js";
export type { PluginLlmConfig, PluginLlmSlot } from "./plugin-llm-config.js";

// ── Types ────────────────────────────────────────────────────────
export type {
  ParsedPluginMd,
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
} from "./types.js";

export { resolveRuntimeProviders } from "./runtime-providers.js";
