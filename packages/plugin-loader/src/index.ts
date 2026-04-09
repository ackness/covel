// ── Parsers ──────────────────────────────────────────────────────
export { parsePluginMd } from './parse-plugin-md.js';
export { parseReference, shouldInjectReference } from './parse-reference.js';

// ── Discovery & Loading ──────────────────────────────────────────
export { discoverPlugins } from './discover.js';
export { loadPluginSummary, loadPluginManifest, loadRuntime } from './load.js';

// ── Registry ─────────────────────────────────────────────────────
export { createPluginRegistry } from './registry.js';
export type { PluginRegistry } from './registry.js';

// ── Session Scope ────────────────────────────────────────────────
export { createSessionScope } from './session-scope.js';
export type { SessionPluginScope } from './session-scope.js';

// ── Trust ────────────────────────────────────────────────────────
export { getPluginTrustInfo } from './trust.js';

// ── Plugin LLM Config ────────────────────────────────────────────
export { loadPluginLlmConfig, parsePluginLlmToml } from './plugin-llm-config.js';
export type { PluginLlmConfig, PluginLlmSlot } from './plugin-llm-config.js';

// ── Types ────────────────────────────────────────────────────────
export type {
  ParsedPluginMd,
  ParsedReference,
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
} from './types.js';
