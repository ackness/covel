import type {
  FailurePolicy,
  HookEvent,
  I18nText,
  Locale,
  RuntimeBudget,
  RuntimeIsolationSpec,
  RuntimeKind,
  RuntimePhase,
  RuntimeTriggerSpec,
  UiSlot,
} from "./common.js";

/** Plugin manifest (plugin.json) */
export interface PluginManifest {
  schemaVersion: string;
  id: string;
  displayName: I18nText;
  version: string;
  author: string;
  description: I18nText;
  defaultLocale: Locale;
  supportedLocales: Locale[];
  loadingOrder?: number;
  requires?: string[];
  supersedes?: string[];
  conflicts?: string[];
  compatibility?: Record<string, string>;
  runtimes?: PublicRuntimeSpec[];
  tools?: PublicToolDefinition[];
  hooks?: PublicHookDefinition[];
  ui?: PublicUiExtension[];
  runtimeSettings?: RuntimeSettingField[];
  permissions?: string[];
  providers?: PublicProviderBinding[];
}

/** Public runtime spec */
export interface PublicRuntimeSpec {
  id: string;
  pluginId: string;
  kind: RuntimeKind;
  phase: RuntimePhase;
  trigger: RuntimeTriggerSpec;
  providerBinding?: string;
  instructionsRef?: string;
  tools: string[];
  hooks: string[];
  budget?: RuntimeBudget;
  output?: RuntimeOutputSpec;
  failurePolicy?: FailurePolicy;
  isolation?: RuntimeIsolationSpec;
}

/** Runtime output spec */
export interface RuntimeOutputSpec {
  proposalKinds?: string[];
}

/** Public tool definition */
export interface PublicToolDefinition {
  id: string;
  kind:
    | "query"
    | "mutate"
    | "emit"
    | "render"
    | "generate"
    | "orchestration"
    | "script"
    | "proxy";
  schema?: unknown;
  permissions?: string[];
}

/** Tool execution context */
export interface ToolExecutionContext<I = unknown> {
  input: I;
  runtimeId: string;
  pluginId: string;
  locale: string;
}

/** Tool execution result */
export interface ToolExecutionResult<O = unknown> {
  output: O;
  proposals?: Array<{
    kind: string;
    payload: unknown;
  }>;
}

/** Public hook definition */
export interface PublicHookDefinition {
  id: string;
  event: HookEvent;
  handlerKind: "command" | "prompt" | "async-command";
  match?: HookMatch;
}

/** Hook match criteria */
export interface HookMatch {
  toolIds?: string[];
  runtimeIds?: string[];
  pluginIds?: string[];
}

/** Public UI extension */
export interface PublicUiExtension {
  id: string;
  slot: UiSlot;
  component: unknown;
  propsSchema?: unknown;
}

/** Public provider binding */
export interface PublicProviderBinding {
  id: string;
  kind: "llm" | "image" | "tts" | "script-host";
  configRef?: string;
  permissions?: string[];
}

/** Runtime setting field */
export interface RuntimeSettingField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  label: I18nText;
  description?: I18nText;
  scope?: "project" | "run" | "request";
  component?: "input" | "textarea" | "toggle" | "select";
  default?: unknown;
  options?: Array<{ label: I18nText; value: string | number | boolean }>;
  affects?: string[];
}

/** Proposal output contract */
export interface PublicProposalOutput {
  items: Array<
    | { kind: "narrative.append"; payload: unknown }
    | { kind: "state.patch"; payload: unknown }
    | { kind: "event.emit"; payload: unknown }
    | { kind: "record.upsert"; payload: unknown }
    | { kind: "ui.render"; payload: unknown }
    | { kind: "asset.generate"; payload: unknown }
  >;
}
