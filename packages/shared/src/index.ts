export {
  playerInputSubmissionSchema,
  turnDigestSchema,
} from "./schemas/execution-snapshots.js";
export * from "./extension-points/index.js";
export { modelFacingJson } from "@covel/plugin-handlers-utils";
export type {
  CharacterSchema,
  CharacterSchemaRecord,
  LorebookOwner,
} from "./types/world-model.js";
export {
  characterSchemaRecordSchema,
  lorebookOwnerSchema,
} from "./schemas/world-model.js";

// ── Types ─────────────────────────────────────────────────────────
export * from "./types/index.js";
export * from "./types/llm-diagnostics.js";
export * from "./llm-request-budget.js";
export { unifyFinishReason } from "./llm-finish-reason.js";
export type { LLMFinishReason } from "./llm-finish-reason.js";
export type {
  EvaluationJson,
  EvaluationValue,
  EvaluationQuestion,
  EvaluationQuestions,
  EvaluationAnswer,
  EvaluationParams,
  EvaluationResult,
} from "./evaluation.js";
export { llmModelBindingSchema } from "./model-binding.js";
export type { LlmModelBinding } from "./model-binding.js";
export {
  defaultModelRoleTag,
  modelOutputTag,
  protocolOutputModalities,
  supportsModelRole,
} from "./model-capabilities.js";
export { projectModelCapabilityForBuiltinAdapter } from "./model-capability-support.js";
export {
  BUILTIN_PROVIDER_PROTOCOLS,
  DEFAULT_PROVIDER_PROTOCOL,
  PROVIDER_PROTOCOL_DESCRIPTORS,
  getProviderProtocolDescriptor,
  isBuiltinProviderProtocol,
  isBuiltinTextProtocol,
  isProviderProtocolId,
} from "./provider-protocols.js";
export type {
  BuiltinProviderProtocol,
  ProviderProtocolDescriptor,
  ProviderProtocolOutput,
} from "./provider-protocols.js";
export type { CharacterRecord } from "./types/character-record.js";
export { materializeCharacterUpsert } from "./proposals/character-upsert.js";
export {
  materializeWorldModel,
  validateWorldModel,
  characterSchemaSetPayloadSchema,
  characterUpsertPayloadSchema,
} from "./proposals/world-model.js";
export type { WorldModelView } from "./proposals/world-model.js";
export { buildFieldsZodFromSchema } from "./schemas/character-fields.js";

// ── Utilities ─────────────────────────────────────────────────────
export { deepMerge } from "./utils/deep-merge.js";
export {
  DEFAULT_LLM_CONTEXT_WINDOW,
  DEFAULT_LLM_OUTPUT_TOKENS,
  resolveLlmTokenLimits,
} from "./utils/llm-token-limits.js";
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
export {
  INSTRUCTION_LOCALES,
  instructionLocaleFor,
  instructionLocaleOverride,
  instructionVariantCandidates,
  isInstructionVariantLocale,
  localeTier,
} from "./utils/instruction-locale.js";
export type {
  InstructionLocale,
  LocaleTier,
} from "./utils/instruction-locale.js";
export { pluginMessagesFor } from "./utils/plugin-messages.js";
export {
  WORLD_EDITIONS_KEY,
  pluginHasTextIn,
  sessionContentLocale,
  worldEditionLocales,
} from "./utils/content-locale.js";
export type { WorldEditions } from "./utils/content-locale.js";
export {
  narratorLore,
  narratorOnlyLoreIssues,
  playerVisibleLore,
  withNarratorOnlyLore,
} from "./utils/narrator-only-lore.js";
export type { NarratorOnlyLoreIssue } from "./utils/narrator-only-lore.js";
export { WORLD_LORE_TOKEN_BUDGET, fitWorldLore } from "./utils/world-lore.js";
export type { FittedWorldLore } from "./utils/world-lore.js";
export type {
  PluginMessageCatalog,
  PluginMessages,
} from "./utils/plugin-messages.js";
export type {
  LocaleDefinition,
  SupportedLocale,
} from "./utils/locale-registry.js";
export {
  resolveI18nText,
  resolveI18nDeep,
  isKnownLocale,
  isLocaleMap,
  localizedWorldText,
  WORLD_LOCALIZED_TEXT_KEY,
} from "./utils/i18n.js";
export {
  applyLocaleOverlay,
  findInlineLocaleMaps,
  isLocaleMapFor,
  splitLocaleMaps,
} from "./utils/locale-overlay.js";
export type {
  ApplyLocaleOverlayOptions,
  LocaleOverlayIssue,
  LocaleOverlayMode,
} from "./utils/locale-overlay.js";
export { collectMediaRefIds } from "./utils/media-ref-scan.js";
export {
  assertJsonValue,
  isJsonValue,
  toJsonValueOrDiagnostic,
} from "./utils/json-value.js";
export {
  CONCEALED_FAILURE_MESSAGE,
  concealedRuntimeIds,
  concealRuntimeResult,
  concealTracePayload,
} from "./utils/concealed-runtime.js";
export {
  HIDDEN_PLUGIN_DATA_NAMESPACE_PREFIX,
  KERNEL_PLUGIN_DATA_OWNER_PREFIX,
  hiddenPluginDataNamespace,
  isControlPlanePluginDataNamespace,
  isHiddenPluginDataNamespace,
  isKernelPluginDataOwner,
  pluginCodeNamespaceWriteError,
  reservedPluginDataNamespaceError,
} from "./utils/plugin-data-namespace.js";
export { decodePageCursor, encodePageCursor } from "./utils/page-cursor.js";
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
  isLoopbackBaseUrl,
  listBuiltinProviderConnections,
} from "./utils/provider-defaults.js";
export type { BuiltinProviderConnection } from "./utils/provider-defaults.js";

// ── Environment Registry ──────────────────────────────────────────
export * from "./env/index.js";

// ── Scheduling IR normalization ───────────────────────────────────
export {
  normalizeRuntimeManifest,
  stageRank,
  stageMessageOrder,
  getRuntimeSpec,
  hasIllegalDetachedContract,
  isTurnDetachedRuntime,
  effectiveTurnCompletion,
} from "./scheduling/normalize.js";
export type { EffectiveTurnCompletion } from "./scheduling/normalize.js";
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
  outputKindSchema,
  pluginDataSchemaDeclSchema,
  pluginDataSchemaMapSchema,
  worldProjectionMapSchema,
  toolsConfigSchema,
  hookDeclarationSchema,
  runtimeManifestInputSchema,
  runtimeManifestAuthoringSchema,
  authoringTriggerConfigSchema,
  stageSchema,
  turnCompletionConfigSchema,
  MAX_SETTLE_WAIT_MS,
  effectsDeclSchema,
  permissionsDeclSchema,
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
  characterSchemaSchema,
  worldManifestSchema,
  WORLD_ACCENT_PATTERN,
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
} from "./schemas/world.js";

export type { WorldManifestInput } from "./schemas/world.js";
export type {
  DimensionValueType,
  DimensionValueSchema,
  WorldDimensionDefinition,
  DimensionSource,
  DimensionRecord,
  DimensionSnapshotEntry,
  DimensionSnapshot,
  DimensionSettlementStatus,
  DimensionSettlementReceipt,
  DimensionSettlementSummary,
  DimensionRecovery,
  DimensionUpdate,
  DimensionInitializePayload,
  DimensionUpdatePayload,
} from "./types/dimensions.js";
export {
  dimensionInitializePayloadSchema,
  dimensionUpdatePayloadSchema,
  DimensionConflictError,
  DimensionValidationError,
  dimensionsJsonEqual,
  materializeDimensionRecords,
} from "./proposals/dimensions.js";
export {
  dimensionQuerySchema,
  queryDimensionSnapshot,
  projectDimensionSnapshot,
} from "./proposals/dimension-query.js";
export {
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  DIMENSION_CONTRACT,
  DIMENSION_MAX_DEPTH,
  DIMENSION_MAX_NODES,
  DIMENSION_MAX_BYTES,
  DIMENSION_MAX_UPDATES,
  dimensionIdSchema,
  dimensionJsonSchema,
  dimensionJsonError,
  dimensionValueSchema,
  worldDimensionDefinitionSchema,
  dimensionSourceSchema,
  dimensionRecordSchema,
  dimensionSnapshotSchema,
  dimensionSettlementReceiptSchema,
  dimensionSettlementSummarySchema,
  validateDimensionValue,
  dimensionSnapshotFromRecords,
  resolveDimensionDefinitionLocale,
  resolveDimensionRecordLocale,
  resolveWorldDimensionsLocale,
} from "./schemas/dimensions.js";

// ── API Transport Contracts ────────────────────────────────────
export {
  createSessionRequestSchema,
  type CreateSessionRequest,
  actionRequestSchema,
  actionTypeSchema,
  apiListResponseSchema,
  apiErrorResponseSchema,
  pluginSummarySchema,
  sseEnvelopeSchema,
  suspensionSummarySchema,
  validateActionRequest,
  worldPluginPlanSchema,
  pluginPackSchema,
  worldCreateRequestSchema,
  worldPatchRequestSchema,
  worldWireRecordSchema,
} from "./schemas/api-contract.js";

export {
  worldDataSourceIdRegex,
  worldDataSourceIdSchema,
  worldDataSourceKindSchema,
  worldDataMergeModeSchema,
  worldDataEffectSchema,
  worldDataVisibilitySchema,
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
export {
  resolveSessionPlugins,
  isBlockingWorldRequirement,
  providedContracts,
} from "./plugin-selection.js";
export {
  checkCollection,
  collectionPluginFacts,
  collectionWorldFacts,
  type CollectionPluginFacts,
  type CollectionWorldFacts,
} from "./collection-check.js";
export type {
  SessionPluginCandidate,
  SessionPluginResolution,
  PluginResolutionRejection,
  UnmetWorldRequirement,
} from "./plugin-selection.js";

export type { LLMProviderRequest } from "./types/llm-provider-request.js";
export {
  compactProviderRequests,
  resolveProviderRequestBody,
  type LLMProviderRequestTrace,
} from "./llm-request-trace.js";

export { REASONING_EFFORT_VALUES, isReasoningEffort } from "./reasoning.js";
export type { ReasoningEffort } from "./reasoning.js";
export {
  githubPluginPreviewRequestSchema,
  githubPluginInstallRequestSchema,
  githubPluginSourceSchema,
  githubPluginTrackingSchema,
  pluginInstallIdSchema,
  githubPluginUpdateCheckRequestSchema,
  githubPluginUpdatePreviewSchema,
  githubPluginUpdateCheckSchema,
  type GithubPluginUpdatePreview,
  githubPluginPreviewSchema,
  githubPluginPreviewsSchema,
  pluginInstallationSchema,
  pluginInstallationsSchema,
  type PluginInstallation,
  type GithubPluginPreview,
} from "./schemas/plugin-install.js";
export {
  COLLECTION_MANIFEST_FILE,
  COLLECTION_MEMBER_LIMIT,
  collectionManifestSchema,
  collectionProblemSchema,
  githubBatchInstallRequestSchema,
  githubBatchInstallResultSchema,
  githubCollectionPreviewSchema,
  githubPackagePreviewSchema,
  type CollectionManifest,
  type CollectionMember,
  type CollectionProblem,
  type GithubBatchInstallResult,
  type GithubCollectionPreview,
  type GithubPackagePreview,
} from "./schemas/collection.js";
export {
  PACKAGE_LINK_LIMIT,
  WORLD_PACKAGE_INFO_KEY,
  isPackageLinkUrl,
  packageAuthorSchema,
  packageCreditFields,
  packageInfoOf,
  packageInfoSchema,
  packageLinkSchema,
  packageLinkUrlSchema,
  type PackageAuthor,
  type PackageInfo,
  type PackageLink,
} from "./schemas/package-info.js";
export {
  hostVersionRangeSchema,
  isHostVersionRange,
  satisfiesHostVersionRange,
} from "./utils/host-version-range.js";

export { pluginManifestSchema } from "./schemas/plugin-manifest.js";
export {
  runtimeAuthoringManifestSchema,
  contractIdSchema,
} from "./schemas/runtime-manifest.js";

export * from "./schemas/catalog.js";

export { estimateTokens } from "@covel/plugin-handlers-utils";

export { FRAMEWORK_TOOL_NAMES } from "@covel/plugin-handlers-utils";

export { isValidPluginSetting } from "./plugin-settings.js";

export * from "./world-data-target.js";
