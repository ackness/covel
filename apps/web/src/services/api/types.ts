import type {
  I18nText,
  PluginUserSettingSpec,
  SessionStatus,
  WorldDimensions,
} from "@covel/shared";

export type {
  PluginRpcRequest,
  PluginRpcResponse,
  SessionStatus,
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
  | "server-file"
  | "server-store"
  | "return-only";

export interface SessionRecord {
  id: string;
  worldId: string;
  status: SessionStatus;
  turnCount: number;
  /** Runtime IDs whose Pre-Game (band 0-99) runs have completed. */
  preGameCompleted?: readonly string[];
  activePlugins?: readonly string[];
  presetId?: string;
  taskBindings?: Record<string, string>;
  runtimeModelOverrides?: Record<string, string>;
  createdAt: string;
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

export interface RuntimeSummary {
  id: string;
  kind: string;
  priority: number;
  trigger: {
    type: string;
    onEvents?: string[];
    interval?: number;
    cooldownTurns?: number;
    maxTriggerCount?: number;
    startTurn?: number;
    topic?: string;
    condition?: string;
    maxRetryCount?: number;
  };
  /** Slot declared by PLUGIN.md `model` (e.g. story/plugin/image). */
  model?: string;
  outputKind?: string;
  capabilities?: string[];
  tags?: string[];
  relations?: Record<string, unknown>;
}

export interface ToolSummary {
  id: string;
  kind: string;
}

export interface PackageSummary {
  name: string;
  displayName?: string | Record<string, string>;
  description?: string | Record<string, string>;
  pluginType?: string;
  source?: "builtin" | "official" | "community";
  enabled: boolean;
  runtimes?: RuntimeSummary[];
  tools?: ToolSummary[];
  requires?: string[];
  capabilities?: string[];
  tags?: string[];
  relations?: Record<string, unknown>;
  version?: string;
  author?: string;
  /** User-editable settings declared in PLUGIN.md frontmatter. */
  userSettings?: readonly PluginUserSettingSpec[];
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

export interface SseEnvelope {
  type: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}
