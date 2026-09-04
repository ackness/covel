import type {
  I18nText,
  Session as SharedSession,
  WorldDimensions,
} from "@covel/shared";

export type {
  PluginDetail,
  PluginLoadError,
  PluginRuntimeSummary,
  PluginSummary,
  PluginRpcRequest,
  PluginRpcResponse,
  SessionStatus,
  SetupRuntimeState,
  SseEnvelope,
  WorldPluginPlan,
} from "@covel/shared";

// -- Shared API types

export interface WorldRecord {
  id: string;
  name: I18nText;
  description: I18nText;
  lore?: I18nText;
  locale?: string;
  tags?: string[];
  dimensions?: WorldDimensions;
  /** World metadata, including storage/source labels used by the world list. */
  metadata?: {
    source?: string;
    /** Preferred initial `GameViewMode` for new sessions (e.g. "stage"). */
    defaultViewMode?: string;
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt?: string;
}

export type GeneratedWorldSaveTarget =
  "server-file" | "server-store" | "return-only";

export interface SessionRecord extends Omit<SharedSession, "worldId"> {
  readonly worldId: string;
  presetId?: string;
}

/**
 * `POST /api/sessions` response: the created session plus its one-time owner
 * token. The token is returned exactly once (only its hash is persisted
 * server-side) and hosted tiers require it on every follow-up call — the client
 * strips it here and stashes it in the session-credential store, so it never
 * reaches the stored `SessionRecord` that read endpoints return.
 */
export interface SessionCreateResponse extends SessionRecord {
  ownerToken?: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant";
  content: string;
  turnId?: string;
  runtimeId?: string;
  /** Runtime kind (e.g. "story", "plugin") - used to filter display on restore. */
  kind?: string;
  block?: Record<string, unknown>;
  createdAt: string;
}

export interface StatePatchRecord {
  id: string;
  sessionId: string;
  summary: string;
  packageName: string;
  data?: unknown;
  createdAt: string;
}

export interface PresetSummary {
  id: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  scope: string;
  /** Effective baseUrl (preset override --> provider default). Undefined if provider not registered. */
  baseUrl?: string;
  /** Effective protocol (openai-chat/anthropic/...). Undefined if unresolvable. */
  protocol?: string;
  /** Slot IDs whose presetId resolves here (e.g. ["default","fast"]). */
  slotBindings?: string[];
}

/** Effective runtime completion policy returned by discovery APIs. */
export interface TurnCompletionSummary {
  mode: "await" | "detached";
  /** Maximum time the detached job may wait before it starts. */
  maxQueueMs?: number;
  maxExecutionMs?: number;
  overlap?: "serial";
  stalePolicy?: "reject";
}

export type WorldDataPreflightDiagnosticLevel = "info" | "warning" | "error";

export interface WorldDataPreflightDiagnostic {
  level: WorldDataPreflightDiagnosticLevel;
  sourceId?: string;
  path?: string;
  schema?: string;
  pointer?: string;
  message: string;
}

export interface WorldDataPreflightTarget {
  kind: "plugin-data" | "lorebook" | "character" | "media-index" | string;
  target: string;
  sourceId: string;
  pluginId?: string;
  namespace?: string;
  key?: string;
}

export interface WorldDataPreflightResponse {
  imported: boolean;
  diagnostics: WorldDataPreflightDiagnostic[];
  planned: number;
  targets: WorldDataPreflightTarget[];
}
