// ── Parsers ──────────────────────────────────────────────────────
export { parsePluginMd } from "./parse-plugin-md.js";

// ── Discovery & Loading ──────────────────────────────────────────
export { discoverPlugins, discoverPluginsMulti } from "./discover.js";
export { loadPluginSummary, loadPluginManifest, loadRuntime } from "./load.js";

// ── Registry ─────────────────────────────────────────────────────
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
  PluginSummary,
  LoadedRuntime,
  PluginEntryStatus,
  PluginRegistryEntry,
  RegistryChangeEvent,
  PluginSource,
  PluginTrustInfo,
  FunctionHandler,
  FunctionHandlerContext,
  PluginRuntimeGateway,
  PluginRuntimeUtils,
  AssetProgressInput,
  ResolvedSlotForPlugin,
  PluginDataWriter,
  PluginLogger,
  FunctionStoreView,
  ImagesContext,
  ImageGenerateInput,
  ImageGenerateOutput,
  SpeechContext,
  SpeechGenerateInput,
  SpeechGenerateOutput,
  SpeechTranscribeInput,
} from "./types.js";
