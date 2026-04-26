// ── Types ─────────────────────────────────────────────────────────
export * from './types/index.js';

// ── Utilities ─────────────────────────────────────────────────────
export { deepMerge } from './utils/deep-merge.js';
export {
  PROMPT_CACHE_BREAKPOINT_MARKER,
  splitPromptCacheSegments,
  stripPromptCacheMarkers,
} from './utils/prompt-cache.js';
export {
  apiKeyEnvNameToProviderId,
  normalizeProviderKeyMap,
  providerIdToApiKeyEnvName,
  providerKeyToId,
  toApiKeyEnvMap,
} from './utils/provider-keys.js';

// ── Environment Registry ──────────────────────────────────────────
export * from './env/index.js';

// ── Plugin Schemas ───────────────────────────────────────────────
export {
  triggerTypeSchema,
  triggerConfigSchema,
  inputInjectDeclSchema,
  inputToolDeclSchema,
  inputConfigSchema,
  outputKindSchema,
  outputConfigSchema,
  toolsConfigSchema,
  configFieldTypeSchema,
  pluginConfigFieldSchema,
  hookDeclarationSchema,
  authorsNoteDeclSchema,
  postHistoryDeclSchema,
  rpcActionDeclSchema,
  rpcDeclMapSchema,
  runtimeManifestSchema,
} from './schemas/plugin.js';

export type { RuntimeManifestInput } from './schemas/plugin.js';

// ── World Schemas ───────────────────────────────────────────────
export {
  i18nTextSchema,
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
} from './schemas/world.js';

export type { WorldManifestInput } from './schemas/world.js';

// ── Validation Utilities ────────────────────────────────────────
export {
  validatePluginManifest,
  validateWorldManifest,
  validateDimensionData,
  validateDimensions,
  formatValidationErrors,
} from './schemas/validate.js';

export type {
  ManifestValidationResult,
  ManifestValidationError,
} from './schemas/validate.js';

// ── Translation-layer Schemas (PR-1) ─────────────────────────────
export {
  runtimeOutputResultSchema,
  runtimeOutputToolCallSchema,
  runtimeOutputPromptMessageSchema,
  runtimeOutputMetaDataSchema,
  runtimeOutputSchema,
} from './schemas/runtime-output.js';

export type { RuntimeOutputSchema } from './schemas/runtime-output.js';

export {
  interactionSourceSchema,
  interactionChannelSchema,
  interactionRecordTypeSchema,
  interactionRecordMetaDataSchema,
  interactionRecordSchema,
} from './schemas/interaction-record.js';

export type { InteractionRecordSchema } from './schemas/interaction-record.js';

// ── Proposal Helpers ─────────────────────────────────────────────
export {
  assetGenerateToLLM,
  assetGenerateToView,
  isAssetGeneratePayload,
  isAssetGenerateView,
} from './proposals/asset-generate.js';

export type {
  AssetGenerateLLMContent,
  AssetGenerateLLMImagePart,
  AssetGenerateLLMPart,
  AssetGenerateLLMTextPart,
  AssetGenerateView,
} from './proposals/asset-generate.js';

// ── Unified Settings Store ─────────────────────────────────────────
export * from './settings/index.js';
