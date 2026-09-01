// ── Types ─────────────────────────────────────────────────────────
export * from "./types/index.js";

// ── Utilities ─────────────────────────────────────────────────────
export { deepMerge } from "./utils/deep-merge.js";
export {
  DEFAULT_FALLBACK_LOCALE,
  DEFAULT_LOCALE,
  LOCALE_CODE_RE,
  LOCALE_DEFINITIONS,
  MAX_LOCALE_CODE_LENGTH,
  SUPPORTED_LOCALES,
  canonicalizeLocale,
  defineLocaleRegistry,
  isDefaultLocale,
  isLocaleCode,
  localeDisplayName,
  localeLanguage,
  localeLookupCandidates,
  localeRegistry,
  localesShareLanguageAndScript,
  normalizeLocale,
} from "./utils/locale-registry.js";
export type {
  LocaleDefinition,
  SupportedLocale,
} from "./utils/locale-registry.js";
export { resolveI18nText, resolveI18nDeep } from "./utils/i18n.js";
export { collectMediaRefIds } from "./utils/media-ref-scan.js";
export {
  assertJsonValue,
  isJsonValue,
  toJsonValueOrDiagnostic,
} from "./utils/json-value.js";
export { reservedPluginDataNamespaceError } from "./utils/plugin-data-namespace.js";
export {
  parseSlashCommandInvocation,
  parseStructuredSlashCommandInvocation,
  tokenizeSlashCommand,
} from "./utils/slash-command.js";
export type { SlashCommandParseResult } from "./utils/slash-command.js";
export {
  SYSTEM_PROXY_IPC_VERSION,
  isSystemProxyResolveRequest,
  isSystemProxyResolveResponse,
} from "./system-proxy-ipc.js";
export type {
  SystemProxyResolveRequest,
  SystemProxyResolveResponse,
} from "./system-proxy-ipc.js";
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
export {
  BUILTIN_PROVIDER_CONNECTIONS,
  getBuiltinProviderConnection,
} from "./utils/provider-defaults.js";
export type {
  BuiltinProviderConnection,
  BuiltinProviderProtocol,
} from "./utils/provider-defaults.js";

// ── Environment Registry ──────────────────────────────────────────
export * from "./env/index.js";

// ── Scheduling IR normalization ───────────────────────────────────
export {
  normalizeRuntimeManifest,
  stageRank,
  stageMessageOrder,
  getRuntimeSpec,
  hasIllegalDetachedContract,
} from "./scheduling/normalize.js";
export { mirrorSetupDone } from "./scheduling/session-clock.js";
export type { SessionClock } from "./scheduling/session-clock.js";
export {
  isSetupRuntime,
  isMainLoopRuntime,
  setupRetryBudget,
  isBudgetedAttempt,
  resolvePendingOrBlocked,
  isSetupSatisfied,
  isSetupDoneForVersion,
  resolveSetupGeneration,
  retrySetup,
  waiveSetup,
} from "./scheduling/setup-state.js";
export type { SetupControlResult } from "./scheduling/setup-state.js";

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
  worldProjectionOutputDeclSchema,
  worldProjectionDeclSchema,
  worldProjectionMapSchema,
  toolsConfigSchema,
  hookDeclarationSchema,
  authorsNoteDeclSchema,
  postHistoryDeclSchema,
  memoryBlockDeclSchema,
  pluginEventDeclSchema,
  pluginRelationsSchema,
  runtimeManifestInputSchema,
  runtimeManifestAuthoringSchema,
  authoringTriggerConfigSchema,
  stageSchema,
  afterRefSchema,
  needsRefSchema,
  runtimeBindingSchema,
  effectsDeclSchema,
  permissionsDeclSchema,
  slashCommandArgumentSpecSchema,
  slashCommandSpecSchema,
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
  WORLD_IR_V1_SCHEMA_URI,
  WORLD_IR_V1_JSON_SCHEMA,
  worldIRJsonValueSchema,
  worldIRV1EntitySchema,
  worldIRV1RelationSchema,
  worldIRV1EventSchema,
  worldIRV1StatementSchema,
  worldIRV1Schema,
  validateWorldIRV1,
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
  WorldIRV1ValidationError,
  WorldIRV1ValidationResult,
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
