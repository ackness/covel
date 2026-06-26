export type {
  MediaRef,
  MediaRefSchema,
  MediaAssetLookup,
  MediaAssetRecord,
  MediaRefRecord,
  MediaLifecyclePolicy,
  MediaCleanupResult,
  MediaStore,
} from "./media.js";

export { mediaRefSchema } from "./media.js";

export type {
  ContentPart,
  TextContentPart,
  ImageContentPart,
} from "./llm-content-parts.js";

export type {
  WorldDataSourceKind,
  WorldDataMergeMode,
  WorldDataEffect,
  WorldDataKey,
  WorldDataSourceDescriptor,
  WorldDataDescriptor,
  WorldDataDiagnosticCounts,
  WorldDataSourceSummary,
  WorldDataMetadataSummary,
} from "./world-data.js";

export type {
  PluginType,
  FrameworkCapabilityTag,
  RuntimeType,
  TriggerType,
  TriggerConfig,
  InputInjectDecl,
  RuntimeInjectDecl,
  PluginDataInjectDecl,
  InputToolDecl,
  InputConfig,
  OutputConfig,
  PluginDataSchemaDecl,
  ToolsConfig,
  ConfigFieldType,
  PluginConfigField,
  PluginRelation,
  PluginRelations,
  PluginRelationTarget,
  PluginTag,
  UISlotType,
  UISpec,
  HookEventName,
  HookEnforce,
  HookDeclaration,
  RuntimeManifest,
  PluginManifest,
  AuthorsNoteDecl,
  PostHistoryDecl,
} from "./plugin.js";

export { FrameworkCapability } from "./plugin.js";
export { HOOK_EVENTS } from "./plugin.js";

export type {
  RuntimeStatus,
  ApprovalStatus,
  ToolCallRecord,
  TokenUsage,
  RuntimeResult,
  TurnInput,
  TurnResult,
  InteractionType,
  FormInteraction,
  ChoiceInteraction,
  ConfirmationInteraction,
  InteractionPayload,
  PendingInputInfo,
  WriteConflictEntry,
  WriteConflict,
} from "./execution.js";

export type {
  StateChangeEntry,
  StateField,
  StateFieldType,
  StateFieldDef,
  StateTableSchema,
} from "./state.js";

export type { MessageType, CovelMessage } from "./events.js";

export type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRecord,
  RpcApprovalPending,
  RpcApprovalDecision,
  RpcApprovalScope,
} from "./approval.js";

export type {
  SessionStatus,
  Session,
  SessionEmbeddingInfo,
} from "./session.js";

export type {
  UIComponentType,
  UIPartStatus,
  UIRenderLayout,
  UIRenderPartRetry,
  UIRenderPart,
  UIRenderPartsInstruction,
  UIRenderLegacyInstruction,
  UIRenderInstruction,
  BlockSchemaMeta,
  BlockSchemaDeclaration,
} from "./ui.js";

export {
  isUIRenderPartsInstruction,
  normalizeUIRenderInstruction,
} from "./ui.js";

export type {
  TurnMessageSourceType,
  TurnMessageSource,
  PlayerInputFieldType,
  PlayerInputField,
  PlayerInputForm,
  TurnMessage,
  PlayerInputSubmission,
  Message,
} from "./message.js";

export type {
  SubscriptionTopic,
  SubscriptionEvent,
  SubscriptionFilter,
} from "./subscription-events.js";

export { SUBSCRIPTION_TOPICS } from "./subscription-events.js";

export type {
  ProposalPayloadMap,
  ProposalType,
  ProposalFor,
  ProposalSource,
  Proposal,
  NarrativeAppendPayload,
  InteractionRequestPayload,
  StatePatchPayload,
  EventEmitPayload,
  UIRenderPayload,
  AssetGeneratePayload,
  PluginDataPayload,
  PluginDataBatchPayload,
  CharacterUpsertPayload,
  WorkingMemorySetPayload,
  LorebookUpsertPayload,
  LorebookUpsertEntry,
  SessionEvent,
  CommitResult,
} from "./proposal.js";
export { PROPOSAL_TYPES } from "./proposal.js";

export type {
  ClientCapabilities,
  ServerCapabilities,
  CommandType,
  SessionCommand,
  SessionCreatePayload,
  SessionRestorePayload,
  TurnSubmitPayload,
  InputSubmitPayload,
  ProtocolEventType,
  ProtocolEvent,
  SessionSnapshot,
  SnapshotMessage,
  SnapshotCharacter,
  SnapshotTraceEvent,
  SnapshotPluginStatus,
  SessionTransport,
  ClientInfo,
} from "./protocol.js";

export type {
  CovelEvent,
  CovelEventType,
  CovelEventMeta,
  CovelEventPayload,
} from "./protocol.js";

export { COVEL_EVENT_META, FORWARDED_EVENT_TYPES } from "./protocol.js";

export type {
  AttributeFieldType,
  AttributeCategory,
  AttributeDefinition,
  CharacterAttributeSchema,
  Character,
} from "./character-schema.js";

export type {
  CharacterBlueprintRole,
  CharacterBlueprintI18nText,
  CharacterBlueprintPersona,
  CharacterBlueprintDialogueExample,
  CharacterBlueprintScenarioDefaults,
  CharacterBlueprintRule,
  CharacterBlueprintMediaRefs,
  CharacterBlueprintInstantiation,
  CharacterBlueprint,
  CharacterBlueprintRecord,
  CharacterBlueprintImportPayload,
  CharacterBlueprintImportResult,
} from "./character-blueprint.js";

export { characterBlueprintToCharacterUpsert } from "./character-blueprint.js";

export type {
  PlayerIdentityCoordinate,
  PlayerIdentityProfile,
  PlayerIdentityRecord,
  PlayerIdentityBinding,
  PlayerIdentitySavePayload,
  PlayerIdentitySaveResult,
} from "./player-identity.js";

export type {
  BranchReplyAction,
  BranchReplyCandidate,
  BranchReplyTurnRecord,
  BranchReplyMessageState,
  BranchReplyCreateCandidatesPayload,
  BranchReplyAcceptCandidatePayload,
  BranchReplyManualPayload,
  BranchReplyRuntimeResult,
} from "./branch-reply.js";

export { playerIdentityToCharacterUpsert } from "./player-identity.js";

export type {
  CharacterPresenceMediaRefs,
  CharacterPresence,
  CharacterPresenceRecord,
  CharacterPresenceSavePayload,
  CharacterPresenceSaveResult,
} from "./character-presence.js";

export type {
  LivingWorldRuleKind,
  LivingWorldRuleCategory,
  LivingWorldRulePosition,
  LivingWorldRuleBudgetClass,
  LivingWorldRuleCoordinate,
  LivingWorldRuleOwner,
  LivingWorldRule,
  LivingWorldRuleRecord,
  LivingWorldRuleSavePayload,
  LivingWorldRuleSaveResult,
} from "./living-world-rules.js";

export type {
  RuntimeOutput,
  RuntimeOutputResult,
  RuntimeOutputToolCall,
  RuntimeOutputPromptMessage,
  RuntimeOutputMetaData,
} from "./runtime-output.js";

export type {
  InteractionRecord,
  InteractionSource,
  InteractionChannel,
  InteractionRecordType,
  InteractionRecordMetaData,
} from "./interaction-record.js";

export type {
  RpcTrustLevel,
  RpcActionDecl,
  RpcDeclMap,
  RpcHandlerStore,
  PluginRpcActionRequest,
  PluginRpcRequest,
  PluginRpcDeferredJob,
  PluginRpcResponse,
  PluginRpcRuntimeRequest,
  PluginRpcRuntimeResultSummary,
} from "./rpc.js";

export type {
  NpcNodeType,
  NpcNode,
  NpcEdge,
  NpcGraphOntology,
  NpcGraphSubgraph,
} from "./npc-graph.js";

export type {
  I18nText,
  World,
  WorldLandmark,
  WorldRegion,
  WorldGeography,
  FactionType,
  InfluenceLevel,
  FactionRelation,
  WorldFaction,
  PowerSystemType,
  PowerTier,
  WorldPowerSystem,
  HistorySignificance,
  WorldHistoryEvent,
  WorldCurrency,
  WorldEconomy,
  SocialClass,
  WorldRace,
  WorldSocialStructure,
  ContentRating,
  WorldTone,
  CombatStyle,
  DifficultyLevel,
  WorldMechanics,
  WorldStartingConditions,
  WorldDimensions,
  WorldPluginPack,
  WorldPluginPolicy,
} from "./world.js";
