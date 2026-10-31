export {
  playerInputSubmissionSchema,
  turnDigestSchema,
} from "./schemas/execution-snapshots.js";
export * from "./extension-points/index.js";
export {
  fillNarrativeTemplate,
  modelFacingJson,
  modelHiddenPaths,
  type ModelHiddenPath,
  type ModelHiddenReason,
} from "@covel/plugin-handlers-utils";
export {
  characterLabel,
  characterNameKey,
  describeUnresolvedCharacter,
  findCharacterAliasConflict,
  mergeCharacterAliases,
  resolveCharacter,
} from "@covel/plugin-handlers-utils";
export type {
  CharacterResolution,
  NamedCharacter,
} from "@covel/plugin-handlers-utils";
export {
  currentCharacterOf,
  primarySeat,
  seatCharacterIds,
} from "@covel/plugin-handlers-utils";
export type {
  Seat,
  SeatCharacter,
  SeatController,
  SeatRole,
} from "@covel/plugin-handlers-utils";
export {
  assertSeatsValid,
  defaultSessionSeats,
  seatsSchema,
} from "./schemas/seat.js";
export {
  ACTION_KIND_NAME_PATTERN,
  BASE_ACTION_KINDS,
  BASE_ACTION_KIND_RULES,
  MAX_ACTIONS_PER_SUBMISSION,
  ROLE_ACTION_KINDS,
  actionKindDeclarationSchema,
  baseActionKindRoles,
  interactionActionKind,
  isBaseActionKind,
  pluginActionKindId,
  turnActionRequestSchema,
  turnActionRequestsSchema,
  turnActionSchema,
} from "./schemas/action.js";
export {
  COMPOSER_TEXTAREA_MIN_LENGTH,
  composerFieldsOf,
} from "./action-kind-fields.js";
export type { ComposerField } from "./action-kind-fields.js";
export type {
  ActionKindDescriptor,
  ActionKindRule,
  ActionTextRule,
  BaseActionKind,
  SessionActionKindsResponse,
  TurnAction,
  TurnActionInteraction,
  TurnActionRequest,
} from "./types/action.js";
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
export {
  TOOL_ERROR_CODES,
  ToolError,
  isToolError,
} from "@covel/plugin-handlers-utils";
export type { ToolModelView } from "@covel/plugin-handlers-utils";
export * from "./types/llm-diagnostics.js";
export * from "./llm-request-budget.js";
export * from "./llm-slots.js";
export {
  isCompleteFinishReason,
  unifyFinishReason,
} from "./llm-finish-reason.js";
export type { LLMFinishReason } from "./llm-finish-reason.js";
export { isAccountFailure } from "./llm-failure-kind.js";
export type { ProviderFailureKind } from "./llm-failure-kind.js";
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
  INPUT_MODALITIES,
  OUTPUT_MODALITIES,
  MODEL_FEATURES,
  defaultModelRoleTag,
  modelOutputTag,
  protocolOutputModalities,
  supportsModelRole,
} from "./model-capabilities.js";
export type {
  InputModality,
  OutputModality,
  ModelFeature,
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
  checkProposalPayload,
  proposalPayloadSchemas,
  type ProposalPayloadCheck,
} from "./proposals/payload-schemas.js";
export {
  materializeWorldModel,
  validateWorldModel,
  characterSchemaSetPayloadSchema,
  characterUpsertPayloadSchema,
} from "./proposals/world-model.js";
export type { WorldModelView } from "./proposals/world-model.js";
export { buildFieldsZodFromSchema } from "@covel/plugin-handlers-utils";
export {
  DATA_OP_KINDS,
  applyDataOps,
  dataOpSchema,
  dataOpsSchema,
  type DataOp,
  type DataOpError,
  type DataOpErrorCode,
  type DataOpKind,
  type DataOpsCurrent,
  type DataOpsResult,
} from "@covel/plugin-handlers-utils";

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
} from "@covel/plugin-handlers-utils";
export {
  INSTRUCTION_LOCALES,
  instructionLocaleFor,
  instructionLocaleOverride,
  instructionVariantCandidates,
  isInstructionVariantLocale,
  localeTier,
} from "@covel/plugin-handlers-utils";
export type {
  InstructionLocale,
  LocaleTier,
} from "@covel/plugin-handlers-utils";
export { pluginMessagesFor } from "./utils/plugin-messages.js";
export {
  WORLD_EDITIONS_KEY,
  pluginHasTextIn,
  sessionContentLocale,
  worldEditionLocales,
} from "./utils/content-locale.js";
export type { WorldEditions } from "./utils/content-locale.js";
export {
  WORLD_SUMMARY_METADATA_KEYS,
  summarizeWorld,
} from "./utils/world-summary.js";
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
} from "@covel/plugin-handlers-utils";
export {
  resolveI18nText,
  resolveI18nDeep,
  isKnownLocale,
  isLocaleMap,
  localizedWorldText,
  WORLD_LOCALIZED_TEXT_KEY,
} from "@covel/plugin-handlers-utils";
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
  pluginDataEntry,
  isKernelPluginDataOwner,
  pluginCodeNamespaceWriteError,
  reservedPluginDataNamespaceError,
} from "./utils/plugin-data-namespace.js";
export {
  MAX_PLUGIN_DATA_VALUE_BYTES,
  pluginDataSizeBytes,
  pluginDataSizeError,
  pluginDataToolSizeError,
} from "./utils/plugin-data-limits.js";
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
  parseProviderKeysEnv,
  providerIdToApiKeyEnvName,
  providerKeyToId,
  toApiKeyEnvMap,
} from "./utils/provider-keys.js";
export {
  BUILTIN_PROVIDER_CONNECTIONS,
  getBuiltinProviderConnection,
  isLoopbackBaseUrl,
  listBuiltinProviderConnections,
  trimTrailingSlashes,
} from "./utils/provider-defaults.js";
export type { BuiltinProviderConnection } from "./utils/provider-defaults.js";
export {
  isLocalNetworkBaseUrl,
  isLoopbackHostUrl,
} from "./utils/local-network.js";
export {
  LOCAL_MODEL_RELAY_CONNECT_SOURCES,
  PAGE_CONNECT_SOURCES,
  withLocalModelRelayConnect,
} from "./utils/page-policy.js";

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
  stageSchema,
  MAX_SETTLE_WAIT_MS,
  effectsDeclSchema,
  permissionsDeclSchema,
} from "./schemas/plugin.js";
export {
  isRuntimeDisablingIssue,
  SERVICE_IMPORT_NAME_PATTERN,
  serviceImportName,
  type RuntimeRuleIssue,
} from "./schemas/runtime-rules.js";
export {
  CURRENT_UI_SPEC_VERSION,
  MAX_UI_WEBVIEW_BYTES,
  pluginUiSpecIssues,
  pluginUiSpecSchema,
  segmentTemplateMatchSchema,
  uiMapDirectiveSchema,
  type PluginUiSpecIssue,
  type PluginUiSpecSlot,
  type SegmentTemplateMatch,
} from "./schemas/ui-spec.js";
export {
  PLUGIN_VIEW_ID_PATTERN,
  parsePluginViewMode,
  pluginViewMode,
  viewModeSchema,
  type PluginViewMode,
  type DefaultViewMode,
} from "./schemas/view-mode.js";

// ── World Schemas ───────────────────────────────────────────────
export {
  i18nTextSchema,
  attributeDefinitionSchema,
  characterSchemaSchema,
  worldManifestSchema,
  worldIdSchema,
  worldPluginPolicySchema,
  WORLD_ACCENT_PATTERN,
  worldAccentColorSchema,
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

export type {
  WorldManifestInput,
  WorldManifest,
  WorldPluginPolicy,
} from "./schemas/world.js";
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
} from "@covel/plugin-handlers-utils/dimensions";
export {
  dimensionInitializePayloadSchema,
  dimensionUpdatePayloadSchema,
  DimensionConflictError,
  DimensionValidationError,
  dimensionsJsonEqual,
  materializeDimensionRecords,
} from "@covel/plugin-handlers-utils/dimensions";
export {
  dimensionQuerySchema,
  queryDimensionSnapshot,
  projectDimensionSnapshot,
} from "@covel/plugin-handlers-utils/dimensions";
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
  resolveWorldDimensionsLocale,
} from "@covel/plugin-handlers-utils/dimensions";

// ── API Transport Contracts ────────────────────────────────────
export {
  createSessionRequestSchema,
  type CreateSessionRequest,
  actionRequestSchema,
  MAX_PLAYER_MESSAGE_CHARS,
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
  worldSummarySchema,
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
  worldDataDescriptorEntrySchema,
  worldDataSourceDescriptorOverrideSchema,
  worldDataDescriptorOverrideSchema,
} from "./schemas/world-data.js";

export type {
  WorldDataDescriptorInput,
  WorldDataDescriptorOverrideInput,
} from "./schemas/world-data.js";

export * from "./schemas/st-import.js";

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

// ── Proposal Helpers ─────────────────────────────────────────────
export {
  assetGenerateToView,
  isAssetGeneratePayload,
  isAssetGenerateView,
  pictureOf,
  picturesShown,
} from "./proposals/asset-generate.js";

export type {
  AssetGenerateView,
  ShownPicture,
} from "./proposals/asset-generate.js";
export {
  resolveSessionPlugins,
  resolveConfirmedSessionPlugins,
  isBlockingWorldRequirement,
  isDependencyRejection,
  disabledDependents,
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

export {
  authoringSourceKind,
  isModelFacingServiceContribution,
  serviceContributionAccess,
  pluginIdSchema,
  pluginManifestSchema,
  serviceContributionContract,
  serviceContributionSchema,
  type ServiceContribution,
} from "./schemas/plugin-manifest.js";
export { FRAMEWORK_PLUGIN_ID } from "./framework-plugin-id.js";
export {
  runtimeAuthoringManifestSchema,
  contractIdSchema,
} from "./schemas/runtime-manifest.js";
export {
  AGENT_LOOP_DEFAULTS,
  DEFAULT_FUNCTION_HANDLER,
  DEFAULT_PLUGIN_ENTRY,
  DEFAULT_RUNTIME_VISIBILITY,
  defaultAgentLoop,
  defaultAgentModel,
  defaultLoopPreset,
  LOOP_PRESETS,
  type AgentLoopDefaults,
  type LoopPresetId,
  type LoopPresetValues,
  type RuntimeVisibility,
} from "./schemas/runtime-defaults.js";

export * from "./schemas/catalog.js";

export {
  compareText,
  estimateTokens,
  validateRandomIntRange,
} from "@covel/plugin-handlers-utils";

export { FRAMEWORK_TOOL_NAMES } from "@covel/plugin-handlers-utils";

export { isValidPluginSetting } from "./plugin-settings.js";

export * from "./world-data-target.js";
export * from "./world-package-paths.js";
export * from "./plugin-frame.js";

export {
  runtimeCaseFileSchema,
  runtimeCasesSchema,
} from "./schemas/runtime-cases.js";
export type {
  RuntimeCase,
  CaseExpectations,
  CaseArtifactConfig,
} from "./schemas/runtime-cases.js";

export {
  packageValidationIssueSchema,
  packageValidationReportSchema,
  type PackageValidationIssue,
  type PackageValidationReport,
} from "./schemas/package-validation.js";

export * from "./schemas/trusted-sources.js";

export { rpcActionNameSchema } from "./schemas/rpc-action.js";
export {
  STORY_LIMITS,
  storyCuesSchema,
  storyMessageSegmentSchema,
  storyOutputJsonSchema,
  storyOutputSchema,
  storySegmentKinds,
  storySegmentSchema,
  storyYields,
} from "./schemas/story-output.js";
export type {
  StoryCues,
  StoryMessageSegment,
  StoryOutput,
  StorySegment,
  StorySegmentKind,
  StoryYield,
} from "@covel/plugin-handlers-utils";
