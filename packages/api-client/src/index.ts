export { ApiClient } from "./client.js";
export type { ApiClientOptions } from "./client.js";
export { HttpTransport } from "./transport/http-transport.js";
export type { Transport, RequestInit, SseEvent } from "./transport/transport.js";
export {
  ApiError,
  NetworkError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "./types/errors.js";

// Resource classes
export { WorldsResource } from "./resources/worlds.js";
export { SessionsResource } from "./resources/sessions.js";
export { MessagesResource } from "./resources/messages.js";
export { CharactersResource } from "./resources/characters.js";
export { PluginDataResource } from "./resources/plugin-data.js";
export { StateResource } from "./resources/state.js";
export { ActionsResource } from "./resources/actions.js";
export { EventsResource } from "./resources/events.js";
export { HealthResource } from "./resources/health.js";
export { UiSpecsResource } from "./resources/ui-specs.js";
export { LlmConfigResource } from "./resources/llm-config.js";
export { TracesResource } from "./resources/traces.js";
export { PluginsResource } from "./resources/plugins.js";
export { LorebookResource } from "./resources/lorebook.js";

// Resource types
export type { World } from "./resources/worlds.js";
export type {
  Session,
  SessionPhase,
  CreateSessionInput,
  SubmitInputItem,
  SubmitInputsBatchInput,
  SubmitInputsBatchResponse,
} from "./resources/sessions.js";
export type { SessionEmbeddingInfo } from "@covel/shared";
export type {
  Message,
  TurnMessage,
  SyncMessageInput,
} from "./resources/messages.js";
export type { Character } from "./resources/characters.js";
export type { PluginDataEntry } from "./resources/plugin-data.js";
export type { UiSpecSlotEntry, UiSpecs } from "./resources/ui-specs.js";
export type { LlmConfig } from "./resources/llm-config.js";
export type { HealthStatus } from "./resources/health.js";
export type { ActionType, ActionRequest } from "./resources/actions.js";
export type {
  PluginPackage,
  PluginPackagesResponse,
  PluginRuntimeSummary,
  PluginToolSummary,
  PluginFlowSegment,
  PluginFlowStep,
  PluginFlowsResponse,
  PluginDocEntry,
  PluginDocsResponse,
} from "./resources/plugins.js";
export type { LorebookEntry } from "./resources/lorebook.js";
export type { TraceEvent, TurnTrace } from "./resources/traces.js";
