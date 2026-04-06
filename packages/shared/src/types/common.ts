/** Locale-aware text: plain string = default locale only, object = locale map */
export type I18nText = string | Record<string, string>;

/** Supported locale identifiers */
export type Locale = "zh-CN" | "en-US" | (string & {});

/** BCP 47 locale format pattern for validation (e.g. "zh", "zh-CN", "en-US") */
export const LOCALE_PATTERN = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/;

/** Default application locale */
export const APP_DEFAULT_LOCALE: Locale = "zh-CN";

/** Minimum supported locale set */
export const MIN_SUPPORTED_LOCALES: Locale[] = ["zh-CN", "en-US"];

/** Runtime budget constraints */
export interface RuntimeBudget {
  /** Hard limit: max LLM tool-calling loop iterations (each iteration may invoke multiple tools) */
  maxSteps?: number;
  /** Hard limit: total runtime timeout in milliseconds */
  timeoutMs?: number;
  /** Best-effort: approximate max tokens */
  maxTokens?: number;
  /** Hard limit: max total tool invocations across all steps. Default: 20. */
  maxToolCalls?: number;
  /** Hard limit: per-tool-call timeout in milliseconds. Default: 10000 (10s). */
  toolTimeoutMs?: number;
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

/** Runtime phase @deprecated Use priority-based scheduling instead. Kept for backward compatibility. */
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

/**
 * Model slot capability tag.
 * Determines compatibility between model slots and plugin runtimes.
 * Cross-tag fallback is forbidden (e.g., an image runtime cannot use a text model).
 */
export type SlotTag = "text" | "image" | (string & {});
