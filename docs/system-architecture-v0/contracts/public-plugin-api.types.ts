import type {
  CompatibilitySpec,
  DependencyRef,
  FailurePolicy,
  HookHandlerKind,
  HookLifecyclePoint,
  HookMatch,
  I18nText,
  LocaleCode,
  PermissionDeclaration,
  RuntimeBudget,
  RuntimeIsolationSpec,
  RuntimeKind,
  RuntimeOutputSpec,
  RuntimePhase,
  RuntimeTriggerSpec,
  SlugId,
  ToolKind,
} from "./common.types";
import type { KernelProposalItem, RuntimeContextView } from "./runtime-kernel.types";

export interface ManifestRuntimeRef {
  id: SlugId;
  kind: RuntimeKind;
  phase: RuntimePhase;
  entry: string;
  trigger?: RuntimeTriggerSpec;
  providerBinding?: SlugId;
  instructionsRef?: string;
  tools?: SlugId[];
  hooks?: SlugId[];
  budget?: RuntimeBudget;
  output?: RuntimeOutputSpec;
  failurePolicy?: FailurePolicy;
  isolation?: RuntimeIsolationSpec;
}

export interface ManifestToolRef {
  id: SlugId;
  kind: ToolKind;
  entry: string;
  inputSchemaRef?: string;
  outputSchemaRef?: string;
  permissions?: string[];
}

export interface ManifestHookRef {
  id: SlugId;
  event: HookLifecyclePoint;
  handlerKind: HookHandlerKind;
  entry: string;
  match?: HookMatch;
}

export interface ManifestUiRef {
  id: SlugId;
  slot: "settings_panel" | "message_block" | "world_panel" | "action_panel";
  entry: string;
  propsSchemaRef?: string;
}

export interface RuntimeSettingOption {
  label: I18nText;
  value: string | number | boolean;
}

export interface RuntimeSettingField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  label: I18nText;
  description?: I18nText;
  scope?: "project" | "run" | "request";
  component?: "input" | "textarea" | "toggle" | "select";
  default?: unknown;
  options?: RuntimeSettingOption[];
  affects?: string[];
}

export interface RuntimeSettingsDeclaration {
  fields: RuntimeSettingField[];
}

export interface PublicProviderBinding {
  id: SlugId;
  kind: "llm" | "image" | "tts" | "script-host";
  configRef?: string;
  permissions?: string[];
}

export interface PublicPluginManifest {
  schemaVersion: "covel.plugin-manifest/v0alpha1";
  id: string;
  displayName: I18nText;
  version: string;
  author?: string;
  description: I18nText;
  defaultLocale: LocaleCode;
  supportedLocales: LocaleCode[];
  loadingOrder?: number;
  requires?: DependencyRef[];
  /** Plugin IDs that this plugin replaces. Superseded plugins are auto-disabled. */
  supersedes?: string[];
  /** Plugin IDs that cannot be enabled simultaneously with this plugin. */
  conflicts?: string[];
  compatibility?: CompatibilitySpec;
  runtimes?: ManifestRuntimeRef[];
  tools?: ManifestToolRef[];
  hooks?: ManifestHookRef[];
  ui?: ManifestUiRef[];
  runtimeSettings?: RuntimeSettingsDeclaration;
  permissions?: PermissionDeclaration;
  providers?: PublicProviderBinding[];
}

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

export interface ToolExecutionContext<I = unknown> {
  runId: string;
  branchId: string;
  turnId: string;
  traceId: string;
  runtimeId?: string;
  pluginId?: string;
  context: RuntimeContextView;
  input: I;
}

export interface ToolExecutionResult<O = unknown> {
  output?: O;
  proposals?: KernelProposalItem[];
}

export interface PublicToolDefinition<I = unknown, O = unknown> {
  id: string;
  kind: ToolKind;
  permissions?: string[];
  execute(input: ToolExecutionContext<I>): Promise<ToolExecutionResult<O>>;
}

export interface PublicHookDefinition {
  id: string;
  event: HookLifecyclePoint;
  handlerKind: HookHandlerKind;
  match?: HookMatch;
}

export interface PublicUiExtension<Props = unknown> {
  id: string;
  slot: "settings_panel" | "message_block" | "world_panel" | "action_panel";
  component: unknown;
  propsSchema?: unknown;
  defaultProps?: Props;
}

export type PublicProposalOutput = {
  items: KernelProposalItem[];
};
