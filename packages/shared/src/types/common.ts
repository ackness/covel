/** Locale-aware text: plain string = default locale only, object = locale map */
export type I18nText = string | Record<string, string>;

/** Supported locale identifiers */
export type Locale = "zh-CN" | "en-US" | (string & {});

/** Default application locale */
export const APP_DEFAULT_LOCALE: Locale = "zh-CN";

/** Minimum supported locale set */
export const MIN_SUPPORTED_LOCALES: Locale[] = ["zh-CN", "en-US"];

/** Runtime budget constraints */
export interface RuntimeBudget {
  /** Hard limit: max tool-calling steps */
  maxSteps?: number;
  /** Hard limit: timeout in milliseconds */
  timeoutMs?: number;
  /** Best-effort: approximate max tokens */
  maxTokens?: number;
}

/** Runtime isolation spec */
export interface RuntimeIsolationSpec {
  readScopes?: string[];
  writeScopes?: string[];
}

/** Runtime trigger spec */
export interface RuntimeTriggerSpec {
  mode: "always" | "interval" | "manual" | "event";
  intervalTurns?: number;
  onEvents?: string[];
}

/** Runtime trigger event */
export interface RuntimeTriggerEvent {
  eventId: string;
  type: string;
  source: string;
  payload?: Record<string, unknown>;
  timestamp: string;
}

/** Proposal item kinds */
export type ProposalKind =
  | "narrative.append"
  | "state.patch"
  | "event.emit"
  | "record.upsert"
  | "ui.render"
  | "asset.generate";

/** Runtime kind */
export type RuntimeKind = "story" | "plugin" | "background" | "verifier";

/** Runtime phase */
export type RuntimePhase = "pre_story" | "story" | "post_story" | "background";

/** Failure policy */
export type FailurePolicy = "continue" | "stop" | "retry" | "disable_runtime";

/** Hook lifecycle points */
export type HookEvent =
  | "TurnStart"
  | "PreToolUse"
  | "PostToolUse"
  | "PreStateCommit"
  | "PostStateCommit"
  | "TurnStop";

/** UI slot identifiers */
export type UiSlot =
  | "settings_panel"
  | "message_block"
  | "world_panel"
  | "action_panel";
