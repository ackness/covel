export type LocaleCode = string;

export type I18nText = string | Record<LocaleCode, string>;

export const DEFAULT_LOCALE = "zh-CN";

export const MIN_SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;

export type PluginId = string;

export type SlugId = string;

/**
 * Qualified tool ID in the form "pluginId/toolId".
 * Used when referencing tools across plugin boundaries.
 * Tools within the same plugin may use bare SlugId for brevity;
 * the loader MUST expand them to qualified form at registration time.
 */
export type QualifiedToolId = `${string}/${string}`;

export type RuntimeKind = "story" | "plugin" | "background" | "verifier";

export type RuntimePhase = "pre_story" | "story" | "post_story" | "background";

export type ToolKind =
  | "query"
  | "mutate"
  | "emit"
  | "render"
  | "generate"
  | "orchestration"
  | "script"
  | "proxy";

export type HookLifecyclePoint =
  | "TurnStart"
  | "PreToolUse"
  | "PostToolUse"
  | "PreStateCommit"
  | "PostStateCommit"
  | "TurnStop";

export type HookHandlerKind = "command" | "prompt" | "async-command";

export type ProposalKind =
  | "narrative.append"
  | "state.patch"
  | "event.emit"
  | "record.upsert"
  | "ui.render"
  | "asset.generate";

export type KernelInputType =
  | "user.input"
  | "system.event"
  | "system.session_start"
  | "system.manual_action"
  | "system.interval_tick"
  | "system.threshold_reached";

export type FailurePolicy = "continue" | "stop" | "retry" | "disable_runtime";

export interface RuntimeTriggerSpec {
  mode?: "always" | "interval" | "manual" | "event";
  onEvents?: string[];
  intervalTurns?: number;
  modeSettingKey?: string;
  intervalSettingKey?: string;
}

/**
 * RuntimeTriggerEvent is the only event shape the kernel routes internally.
 * It carries source metadata so later tracing and auditing do not depend on
 * the original caller shape.
 */
export interface RuntimeTriggerEvent {
  type: string;
  sourceKind: "user" | "system" | "runtime" | "tool" | "hook" | "commit";
  sourceId?: string;
  payload: Record<string, unknown>;
}

export interface RuntimeBudget {
  maxSteps?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface RuntimeOutputSpec {
  mode?: "proposal" | "text" | "json" | "none";
}

export interface RuntimeIsolationSpec {
  readScopes?: string[];
  writeScopes?: string[];
  allowScripts?: boolean;
  allowMcp?: boolean;
}

export interface HookMatch {
  toolIds?: SlugId[];
  runtimeIds?: SlugId[];
  eventTypes?: string[];
}

export interface CompatibilitySpec {
  app?: string;
  engine?: string;
  pluginApi?: string;
}

export interface DependencyRef {
  id: PluginId;
  versionRange?: string;
  optional?: boolean;
}

export interface PermissionDeclaration {
  toolScopes?: string[];
  stateScopes?: string[];
  recordScopes?: string[];
  providerScopes?: string[];
  allowScripts?: boolean;
  allowNetwork?: boolean;
  allowFilesystem?: boolean;
}
