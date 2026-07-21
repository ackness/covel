// ── Types ─────────────────────────────────────────────────────────
export * from "./types/index.js";

// ── Utilities ─────────────────────────────────────────────────────
export { deepMerge } from "./utils/deep-merge.js";
export { resolveI18nText, resolveI18nDeep } from "./utils/i18n.js";
export { collectMediaRefIds } from "./utils/media-ref-scan.js";
export { reservedPluginDataNamespaceError } from "./utils/plugin-data-namespace.js";
export {
  MAX_WORKING_MEMORY_ENTRIES,
  MAX_WORKING_MEMORY_VALUE_CHARS,
  workingMemoryQuotaViolation,
} from "./utils/working-memory-quota.js";
export type { WorkingMemoryQuotaViolation } from "./utils/working-memory-quota.js";
export {
  MAX_CACHE_BREAKPOINTS,
  PROMPT_CACHE_BREAKPOINT_MARKER,
  splitPromptCacheSegments,
  stripPromptCacheMarkers,
} from "./utils/prompt-cache.js";
export {
  apiKeyEnvNameToProviderId,
  normalizeProviderKeyMap,
  providerIdToApiKeyEnvName,
  providerKeyToId,
  toApiKeyEnvMap,
} from "./utils/provider-keys.js";

// ── Environment Registry ──────────────────────────────────────────
export * from "./env/index.js";

// ── Plugin Schemas ───────────────────────────────────────────────
export {
  triggerTypeSchema,
  triggerConfigSchema,
  inputInjectDeclSchema,
  inputToolDeclSchema,
  inputConfigSchema,
  outputKindSchema,
  outputConfigSchema,
  pluginDataSchemaDeclSchema,
  pluginDataSchemaMapSchema,
  toolsConfigSchema,
  hookDeclarationSchema,
  authorsNoteDeclSchema,
  postHistoryDeclSchema,
  rpcActionDeclSchema,
  rpcDeclMapSchema,
  memoryBlockDeclSchema,
  pluginEventDeclSchema,
  pluginRelationsSchema,
  runtimeManifestSchema,
  validateRuntimeManifestSemantics,
} from "./schemas/plugin.js";

export type {
  RuntimeManifestInput,
  RuntimeManifestSemanticDiagnostic,
  RuntimeManifestSemanticDiagnosticCode,
} from "./schemas/plugin.js";

// ── World Schemas ───────────────────────────────────────────────
export {
  i18nTextSchema,
  attributeDefinitionSchema,
  worldManifestSchema,
  worldDimensionsSchema,
  worldGeographySchema,
  worldFactionSchema,
  worldPowerSystemSchema,
  worldHistoryEventSchema,
  worldEconomySchema,
  worldSocialStructureSchema,
  worldToneSchema,
  worldMechanicsSchema,
  worldStartingConditionsSchema,
  DIMENSION_KEY_SCHEMAS,
  DIMENSION_KEYS,
} from "./schemas/world.js";

export type { WorldManifestInput } from "./schemas/world.js";

export {
  worldDataSourceIdRegex,
  worldDataSourceIdSchema,
  worldDataSourceKindSchema,
  worldDataMergeModeSchema,
  worldDataEffectSchema,
  worldDataSourceDescriptorSchema,
  worldDataDescriptorSchema,
  worldDataSourceDescriptorOverrideSchema,
  worldDataDescriptorOverrideSchema,
  worldDataDiagnosticCountsSchema,
  worldDataSourceSummarySchema,
  worldDataMetadataSummarySchema,
} from "./schemas/world-data.js";

export type {
  WorldDataDescriptorInput,
  WorldDataDescriptorOverrideInput,
} from "./schemas/world-data.js";

// ── Validation Utilities ────────────────────────────────────────
export {
  validatePluginManifest,
  validateWorldManifest,
  validateDimensionData,
  validateDimensions,
  formatValidationErrors,
} from "./schemas/validate.js";

export type {
  ManifestValidationResult,
  ManifestValidationError,
} from "./schemas/validate.js";

// ── Translation-layer Schemas ─────────────────────────────
export {
  runtimeOutputResultSchema,
  runtimeOutputToolCallSchema,
  runtimeOutputPromptMessageSchema,
  runtimeOutputMetaDataSchema,
  runtimeOutputSchema,
} from "./schemas/runtime-output.js";

export type { RuntimeOutputSchema } from "./schemas/runtime-output.js";

export {
  interactionSourceSchema,
  interactionChannelSchema,
  interactionRecordTypeSchema,
  interactionRecordMetaDataSchema,
  interactionRecordSchema,
} from "./schemas/interaction-record.js";

export type { InteractionRecordSchema } from "./schemas/interaction-record.js";

// ── Proposal Helpers ─────────────────────────────────────────────
export {
  assetGenerateToLLM,
  assetGenerateToView,
  assetGenerateViewToLLM,
  isAssetGeneratePayload,
  isAssetGenerateView,
} from "./proposals/asset-generate.js";

export type {
  AssetGenerateLLMContent,
  AssetGenerateLLMImagePart,
  AssetGenerateLLMPart,
  AssetGenerateLLMTextPart,
  AssetGenerateView,
} from "./proposals/asset-generate.js";
