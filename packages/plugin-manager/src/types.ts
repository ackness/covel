// ── Plugin Manifest (V1 schema: covel.plugin/v1) ────────────────────

export interface I18nText {
  [locale: string]: string;
}

export interface PluginManifest {
  schemaVersion: string;
  id: string;
  pluginType: "core-plugin" | "plugin";
  displayName: I18nText;
  version: string;
  author: string;
  description: I18nText;
  defaultLocale: string;
  supportedLocales: string[];
  dependencies?: string[];
  actions?: PluginAction[];
  blockSchemas?: BlockSchemaDeclaration[];
  runtimeIds: string[];
}

export interface PluginAction {
  id: string;
  label: I18nText;
  uiSlot: string;
  async?: boolean;
  workflow?: {
    steps: string[];
    resultRuntimeId: string;
  };
  progressLabels?: Record<string, I18nText>;
  resultBlock?: {
    type: string;
    uiSlot: string;
  };
}

export interface BlockSchemaDeclaration {
  type: string;
  interactive: boolean;
  meta: {
    displayName: I18nText;
    description?: string;
  };
  dataSchema: Record<string, unknown>;
}

// ── Runtime Manifest ────────────────────────────────────────────────

export interface RuntimeManifest {
  id: string;
  displayName: I18nText;
  priority: number;
  trigger: RuntimeTrigger;
  limits?: RuntimeLimits;
  instructionsRef?: string;
  outputSchemaRef?: string;
  llmConfigRef?: string;
  settings?: RuntimeSetting[];
  systemTools?: string[];
  toolImports?: string[];
  tableAccess?: {
    read?: string[];
    writeOwnedOnly?: boolean;
  };
  budget?: RuntimeBudget;
}

export interface RuntimeTrigger {
  type: "pre-game-once" | "turn" | "event" | "manual" | "approval-callback";
  events?: string[];
  action?: string;
  tool?: string;
}

export interface RuntimeLimits {
  maxRunsPerSession?: number | null;
  maxRunsPerTurn?: number | null;
}

export interface RuntimeSetting {
  key: string;
  type: "string" | "number" | "boolean" | "enum";
  label: I18nText;
  description?: I18nText;
  default?: unknown;
  options?: Array<{ value: string | number | boolean; label: I18nText }>;
}

export interface RuntimeBudget {
  maxSteps?: number;
  timeoutMs?: number;
  maxToolCalls?: number;
}

// ── Tool Definition (from tools/*.js files) ─────────────────────────

export interface ToolFileDefinition {
  id: string;
  description?: string;
  exported: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execute: (ctx: unknown) => Promise<unknown>;
}

// ── Loaded Plugin ───────────────────────────────────────────────────

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  runtimes: Map<string, LoadedRuntime>;
  generationId: string;
}

export interface LoadedRuntime {
  manifest: RuntimeManifest;
  dir: string;
  pluginId: string;
  instructionsPath?: string;
  pluginPromptPath?: string;
  outputSchemaPath?: string;
  llmConfigPath?: string;
  toolFiles: string[];
  scriptFiles: string[];
  referenceFiles: string[];
}

// ── Plugin Info (public read-only view) ─────────────────────────────

export interface PluginInfo {
  id: string;
  pluginType: "core-plugin" | "plugin";
  displayName: I18nText;
  version: string;
  runtimeIds: string[];
  generationId: string;
  enabled: boolean;
}

// ── Plugin Load Result ──────────────────────────────────────────────

export interface PluginLoadResult {
  pluginId: string;
  success: boolean;
  errors?: string[];
  runtimeCount?: number;
}

// ── Registries ──────────────────────────────────────────────────────

export interface PluginRegistries {
  plugins: PluginRegistry;
  runtimes: V1RuntimeRegistry;
  tools: V1ToolRegistry;
}

export interface PluginRegistry {
  get(pluginId: string): LoadedPlugin | undefined;
  list(): PluginInfo[];
  has(pluginId: string): boolean;
}

export interface V1RuntimeRegistry {
  get(pluginId: string, runtimeId: string): LoadedRuntime | undefined;
  listByPlugin(pluginId: string): LoadedRuntime[];
  listAll(): LoadedRuntime[];
}

export interface V1ToolRegistry {
  register(definition: RegisteredToolV1): void;
  unregisterByPlugin(pluginId: string): void;
  setRuntimeImports(pluginId: string, runtimeId: string, imports: string[]): void;
  resolveForRuntime(pluginId: string, runtimeId: string): RegisteredToolV1[];
  getQualified(id: string): RegisteredToolV1 | undefined;
}

export interface RegisteredToolV1 {
  qualifiedId: string;
  pluginId: string;
  runtimeId: string;
  toolId: string;
  description?: string;
  exported: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execute: (ctx: unknown) => Promise<unknown>;
}

// ── PluginManager Interface ─────────────────────────────────────────

export interface PluginManager {
  loadAll(baseDir: string): Promise<PluginLoadResult[]>;
  load(pluginDir: string): Promise<PluginLoadResult>;
  reload(pluginId: string): Promise<void>;
  unload(pluginId: string): Promise<void>;

  enable(pluginId: string, sessionId: string): Promise<void>;
  disable(pluginId: string, sessionId: string): Promise<void>;

  list(): PluginInfo[];
  get(pluginId: string): PluginInfo | undefined;

  readonly registries: PluginRegistries;
}
