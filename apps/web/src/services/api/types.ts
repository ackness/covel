import type { I18nText, SessionStatus, WorldDimensions } from "@covel/shared";

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
  metadata?: { source?: string; [key: string]: unknown };
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
  userSettings?: Array<{
    key: string;
    type: "text" | "number" | "toggle" | "select" | "textarea";
    default: unknown;
    label: string | Record<string, string>;
    description?: string | Record<string, string>;
    min?: number;
    max?: number;
    step?: number;
    options?: Array<{ value: string; label: string | Record<string, string> }>;
  }>;
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

export interface CommandSummary {
  name: string;
  pluginId: string;
  description: string;
  usage?: string;
  examples?: string[];
  positionalHints?: string[];
  flagHints?: Record<string, string>;
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
