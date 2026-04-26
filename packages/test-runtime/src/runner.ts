import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimeManifest, RuntimeResult, TurnInput } from '@covel/shared';
import {
  BUNDLED_MODEL_DB_PATH,
  createGateway,
  createModelDatabase,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
  fetchWithRetry,
  loadLlmConfig,
  parseLlmConfig,
  setModelDatabase,
  validateBaseUrlForPlugin,
  type AiConfig,
  type ModelSlotConfig,
} from '@covel/ai-provider';
import {
  providerApiKeysFromEnv,
  providerIdToApiKeyEnvName,
  readRuntimeEnv,
} from '@covel/shared';
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
  type LoadedRuntime,
  type PluginDiscoveryResult,
  type PluginRuntimeGateway,
  type PluginRuntimeUtils,
} from '@covel/plugin-loader';
import { createMemoryMediaStore, createMemoryStore } from '@covel/store';
import type { DataStore, MediaStore } from '@covel/store';
import {
  createToolExecutor,
  createFunctionStoreView,
  createGatewayAdapter,
  createPluginDataWriter,
  createPluginLogger,
  createRuntimeMediaContext,
  createPluginRuntimeGateway,
  executeTurn,
  processRuntimeResult,
  type LLMAdapter,
  type LLMResponse,
} from '@covel/runtime';
import {
  builtinUITools,
  createCharacterTools,
  createPluginDataTools,
  runtimeDoneTool,
  suspendTool,
  tool,
  z,
  type ToolModule,
} from '@covel/tools';

export interface RunRuntimeDebugOptions {
  readonly target?: string;
  readonly runtimeId?: string;
  readonly pluginId?: string;
  readonly pluginsDir?: string;
  readonly sessionId?: string;
  readonly locale?: string;
  readonly message?: string;
  readonly payload?: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
  readonly userSettings?: Record<string, unknown>;
  readonly llmResponse?: Record<string, unknown>;
  readonly llmResponses?: readonly Record<string, unknown>[];
  readonly llmContent?: string;
  readonly llmObject?: Record<string, unknown>;
  /** Optional preset id surfaced by the mock gateway's resolveSlot. */
  readonly mockPresetId?: string;
  readonly showPrompts?: boolean;
  readonly ignoreUpstreams?: boolean;
  readonly expectsBackgroundFollower?: boolean;
  readonly mode?: 'mock' | 'live';
  readonly caseName?: string;
  readonly mediaStore?: MediaStore;
}

export interface RunRuntimeDebugResult {
  readonly status: 'ok';
  readonly mode: 'mock' | 'live';
  readonly caseName?: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly runtimeResults: readonly RuntimeResult[];
  readonly jobs: readonly {
    readonly jobId: string;
    readonly runtimeId: string;
    readonly pluginId: string;
    readonly status: 'done' | 'failed';
  }[];
  readonly deferredFollowers: readonly {
    readonly runtimeId: string;
    readonly pluginId: string;
    readonly triggerEvent: { readonly topic: string; readonly data: Readonly<Record<string, unknown>> };
  }[];
  readonly pluginData: Readonly<Record<string, ReadonlyArray<{ readonly key: string; readonly value: unknown }>>>;
  readonly logs: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
  readonly llmCalls: readonly unknown[];
  readonly artifacts?: readonly CaseArtifact[];
  readonly assertions?: readonly CaseAssertion[];
}

export interface RunRuntimeCasesResult {
  readonly status: 'ok';
  readonly mode: 'mock' | 'live';
  readonly pluginId: string;
  readonly cases: readonly {
    readonly name: string;
    readonly status: 'passed' | 'failed';
    readonly result: RunRuntimeDebugResult;
  }[];
}

interface RuntimeCaseFile {
  readonly cases?: readonly RuntimeCase[];
}

interface RuntimeCase {
  readonly name: string;
  readonly runtimeId: string;
  readonly pluginId?: string;
  readonly message?: string;
  readonly payload?: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
  readonly userSettings?: Record<string, unknown>;
  readonly llmResponse?: Record<string, unknown>;
  readonly llmResponses?: readonly Record<string, unknown>[];
  readonly llmContent?: string;
  readonly llmObject?: Record<string, unknown>;
  readonly mockPresetId?: string;
  readonly ignoreUpstreams?: boolean;
  readonly expectsBackgroundFollower?: boolean;
  readonly mode?: 'mock' | 'live' | 'both';
  readonly expect?: CaseExpectations;
  readonly artifacts?: CaseArtifactConfig;
}

interface CaseExpectations {
  readonly runtimeResults?: readonly {
    readonly runtimeId?: string;
    readonly status: RuntimeResult['status'];
    readonly errorIncludes?: string;
  }[];
  readonly events?: readonly string[];
  readonly logs?: readonly string[];
  readonly pluginData?: readonly {
    readonly namespace: string;
    readonly key?: string;
    readonly status?: string;
    readonly field?: string;
  }[];
  readonly assetGenerations?: readonly {
    readonly modality?: string;
    readonly field?: string;
  }[];
}

interface CaseAssertion {
  readonly status: 'passed' | 'failed';
  readonly message: string;
}

interface CaseArtifactConfig {
  readonly saveImages?: {
    readonly namespace?: string;
    readonly dir?: string;
    readonly field?: string;
  };
}

interface CaseArtifact {
  readonly type: 'image';
  readonly namespace: string;
  readonly key: string;
  readonly path: string;
  readonly source: 'media';
  readonly mimeType?: string;
}

const DEFAULT_LLM_TOML = `
[covel.story]
provider = "deepseek"
model    = "deepseek-chat"
baseUrl  = "https://api.deepseek.com"
protocol = "openai-chat-v1"
`;

const PLUGIN_UTILS: PluginRuntimeUtils = {
  validateBaseUrl: validateBaseUrlForPlugin,
  fetchWithRetry,
};

class DebugLLM implements LLMAdapter {
  readonly calls: unknown[] = [];
  private readonly responses: readonly LLMResponse[];
  private nextResponseIndex = 0;
  private readonly showPrompts: boolean;

  constructor(options: RunRuntimeDebugOptions) {
    this.showPrompts = options.showPrompts === true;
    this.responses = normalizeLlmResponses(options);
  }

  async generate(params: Parameters<LLMAdapter['generate']>[0]): Promise<LLMResponse> {
    const callIndex = this.nextResponseIndex;
    this.calls.push({
      callIndex,
      model: params.model,
      toolNames: params.tools?.map((t) => t.name) ?? [],
      responseFormat: params.responseFormat,
      ...(this.showPrompts ? { messages: params.messages } : {}),
    });
    const response = this.responses[Math.min(this.nextResponseIndex, this.responses.length - 1)]!;
    this.nextResponseIndex += 1;
    return response;
  }
}

function normalizeLlmResponses(options: RunRuntimeDebugOptions): readonly LLMResponse[] {
  if (options.llmResponses && options.llmResponses.length > 0) {
    return options.llmResponses.map((raw) => normalizeRawLlmResponse(raw));
  }
  return [normalizeLlmResponse(options)];
}

function normalizeLlmResponse(options: RunRuntimeDebugOptions): LLMResponse {
  const raw = options.llmResponse;
  if (raw) {
    return normalizeRawLlmResponse(raw);
  }
  const content = options.llmObject
    ? JSON.stringify(options.llmObject)
    : options.llmContent ?? '{"ok":true}';
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function normalizeRawLlmResponse(raw: Record<string, unknown>): LLMResponse {
  return {
    content: typeof raw.content === 'string' || raw.content === null ? raw.content : '',
    toolCalls: Array.isArray(raw.toolCalls) ? raw.toolCalls as LLMResponse['toolCalls'] : [],
    finishReason: raw.finishReason === 'tool_calls' || raw.finishReason === 'length' || raw.finishReason === 'error'
      ? raw.finishReason
      : 'stop',
    usage: isUsage(raw.usage) ? raw.usage : { inputTokens: 1, outputTokens: 1 },
  };
}

function isUsage(value: unknown): value is { inputTokens: number; outputTokens: number } {
  if (!value || typeof value !== 'object') return false;
  const usage = value as { inputTokens?: unknown; outputTokens?: unknown };
  return typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number';
}

function expandPath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

function defaultPluginsDir(): string {
  return expandPath(process.env.COVEL_USER_PLUGINS_DIR ?? '~/.covel/plugins');
}

function pluginIdFromRuntime(runtimeId: string): string {
  return runtimeId.includes('/') ? runtimeId.split('/')[0]! : runtimeId;
}

function makeGateway(options: RunRuntimeDebugOptions): PluginRuntimeGateway {
  return {
    async generateText(input) {
      return {
        text: input.prompt ?? input.messages?.map((m) => m.content).join('\n') ?? '',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async generateObject<T = unknown>() {
      return {
        object: { ok: true } as T,
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    resolveSlot() {
      // Mock harness: return a synthetic slot config so plugins that own
      // their own wire (e.g. openai-image-gen) can be unit-tested without
      // a live llm.toml. Live mode replaces this whole gateway with a
      // real one via createPluginRuntimeGateway().
      return {
        presetId: options.mockPresetId ?? 'mock-image',
        provider: 'mock',
        protocol: 'openai-chat-v1',
        baseUrl: 'mock://covel-test-runtime/v1',
        apiKey: 'mock-api-key',
        model: 'mock-model',
        tag: 'image',
        metadata: {},
      };
    },
  };
}

function loadKeysEnvInto(target: NodeJS.ProcessEnv): void {
  const env = readRuntimeEnv(target);
  const covelHome = env.covelHome ?? path.join(os.homedir(), '.covel');
  const file = path.join(covelHome, 'keys.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf-8').split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    const envKey = providerIdToApiKeyEnvName(key);
    if (envKey && target[envKey] === undefined) target[envKey] = val;
  }
}

function configureSlots(config: AiConfig): ReturnType<typeof createSlotRegistry> {
  const presetRegistry = createPresetRegistry({
    profiles: config.profiles,
    presets: config.presets,
  });
  const slotRegistry = createSlotRegistry({ presetRegistry });
  const slots: Record<string, ModelSlotConfig> = {};
  for (const preset of config.presets) {
    if (preset.defaultSlot && preset.enabled) {
      slots[preset.defaultSlot] = {
        slotId: preset.defaultSlot,
        presetId: preset.id,
        tag: preset.tag ?? 'text',
      };
    }
  }
  slotRegistry.configure({ slots });
  return slotRegistry;
}

function loadModelDb(): void {
  const env = readRuntimeEnv();
  const candidates = [
    env.modelDbPath,
    env.userConfigDir ? path.resolve(env.userConfigDir, 'model-db.json') : undefined,
    BUNDLED_MODEL_DB_PATH,
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const data = JSON.parse(raw) as Parameters<typeof createModelDatabase>[0];
      setModelDatabase(createModelDatabase(data));
      return;
    } catch {
      // Try the next candidate.
    }
  }
}

function makeLiveAdapters(): { llm: LLMAdapter; gateway: PluginRuntimeGateway } {
  loadKeysEnvInto(process.env);
  loadModelDb();

  const env = readRuntimeEnv();
  const covelHome = env.covelHome ?? path.join(os.homedir(), '.covel');
  const llmTomlCandidates = [
    env.llmToml ? path.resolve(env.llmToml) : undefined,
    path.join(covelHome, 'llm.toml'),
    path.resolve(process.cwd(), 'llm.toml'),
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);

  let config: AiConfig;
  let loaded: ReturnType<typeof loadLlmConfig> | null = null;
  for (const candidate of llmTomlCandidates) {
    try {
      loaded = loadLlmConfig(candidate);
      if (loaded) break;
    } catch {
      loaded = null;
    }
  }
  config = loaded?.aiConfig ?? parseLlmConfig(DEFAULT_LLM_TOML).aiConfig;

  const providerRegistry = createProviderRegistry({
    providerDefaults: config.providers,
  });
  const presetRegistry = createPresetRegistry({
    profiles: config.profiles,
    presets: config.presets,
  });
  const slotRegistry = configureSlots(config);
  const aiGateway = createGateway({ providerRegistry, presetRegistry, slotRegistry });
  const apiKeys = providerApiKeysFromEnv(process.env);
  return {
    llm: createGatewayAdapter(aiGateway, { apiKeys }),
    gateway: createPluginRuntimeGateway(aiGateway, { apiKeys }),
  };
}

async function loadLocalTools(
  discovery: PluginDiscoveryResult,
  manifests: readonly RuntimeManifest[],
): Promise<readonly ToolModule[]> {
  const loaded: ToolModule[] = [];
  for (const manifest of manifests) {
    for (const localPath of manifest.tools?.local ?? []) {
      const fullPath = path.resolve(discovery.rootPath, localPath);
      const rel = path.relative(discovery.rootPath, fullPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`tools.local path escapes plugin root: ${localPath}`);
      }
      if (!fs.existsSync(fullPath)) {
        throw new Error(`tools.local file not found: ${fullPath}`);
      }
      const mod = await import(pathToFileURL(fullPath).href);
      const exported = mod.default ?? Object.values(mod)[0];
      const candidate = typeof exported === 'function'
        ? exported({ tool, z })
        : exported;
      if (candidate && typeof candidate === 'object' && (candidate as { _type?: unknown })._type === 'covel-tool') {
        loaded.push(candidate as ToolModule);
      }
    }
  }
  return loaded;
}

async function listPluginDataByNamespace(
  store: DataStore,
  sessionId: string,
  pluginId: string,
): Promise<Record<string, Array<{ key: string; value: unknown }>>> {
  const rows = await store.listPluginData(sessionId, pluginId);
  const out: Record<string, Array<{ key: string; value: unknown }>> = {};
  for (const row of rows) {
    const list = out[row.namespace] ?? [];
    list.push({ key: row.key, value: row.value });
    out[row.namespace] = list;
  }
  return out;
}

function collectEventTopics(runtimeResults: readonly RuntimeResult[]): Set<string> {
  const topics = new Set<string>();
  for (const result of runtimeResults) {
    const output = result.output;
    if (!output || typeof output !== 'object') continue;
    const events = (output as { events?: unknown }).events;
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const topic = (event as { topic?: unknown }).topic;
      if (typeof topic === 'string') topics.add(topic);
    }
  }
  return topics;
}

function evaluateExpectations(
  expect: CaseExpectations | undefined,
  result: RunRuntimeDebugResult,
): readonly CaseAssertion[] {
  if (!expect) return [];
  const assertions: CaseAssertion[] = [];
  for (const expected of expect.runtimeResults ?? []) {
    const matched = result.runtimeResults.some((runtimeResult) => {
      if (expected.runtimeId && runtimeResult.runtimeId !== expected.runtimeId) return false;
      if (runtimeResult.status !== expected.status) return false;
      if (expected.errorIncludes) {
        return typeof runtimeResult.error === 'string' && runtimeResult.error.includes(expected.errorIncludes);
      }
      return true;
    });
    assertions.push({
      status: matched ? 'passed' : 'failed',
      message: `runtime:${expected.runtimeId ?? '*'}:${expected.status}`,
    });
  }
  const eventTopics = collectEventTopics(result.runtimeResults);
  for (const topic of expect.events ?? []) {
    assertions.push({
      status: eventTopics.has(topic) ? 'passed' : 'failed',
      message: `event:${topic}`,
    });
  }
  const logMessages = new Set(
    result.logs
      .map((row) => row.value)
      .filter((value): value is { message?: unknown } => Boolean(value) && typeof value === 'object')
      .map((value) => value.message)
      .filter((value): value is string => typeof value === 'string'),
  );
  for (const message of expect.logs ?? []) {
    assertions.push({
      status: logMessages.has(message) ? 'passed' : 'failed',
      message: `log:${message}`,
    });
  }
  for (const expected of expect.pluginData ?? []) {
    const rows = result.pluginData[expected.namespace] ?? [];
    const matched = rows.some((row) => {
      if (expected.key && row.key !== expected.key) return false;
      const value = row.value;
      if (!value || typeof value !== 'object') return false;
      const record = value as Record<string, unknown>;
      if (expected.status && record.status !== expected.status) return false;
      if (expected.field && !(expected.field in record)) return false;
      return true;
    });
    assertions.push({
      status: matched ? 'passed' : 'failed',
      message: `pluginData:${expected.namespace}`,
    });
  }
  for (const expected of expect.assetGenerations ?? []) {
    const matched = collectAssetGenerations(result.runtimeResults).some((asset) => {
      if (expected.modality && asset.modality !== expected.modality) return false;
      if (expected.field && !(expected.field in asset)) return false;
      return true;
    });
    assertions.push({
      status: matched ? 'passed' : 'failed',
      message: `assetGenerations:${expected.modality ?? '*'}`,
    });
  }
  return assertions;
}

function collectAssetGenerations(runtimeResults: readonly RuntimeResult[]): ReadonlyArray<Record<string, unknown>> {
  const assets: Record<string, unknown>[] = [];
  for (const runtimeResult of runtimeResults) {
    const output = runtimeResult.output;
    if (!output || typeof output !== 'object') continue;
    const assetGenerations = (output as Record<string, unknown>).assetGenerations;
    if (!Array.isArray(assetGenerations)) continue;
    for (const asset of assetGenerations) {
      if (asset && typeof asset === 'object') {
        assets.push(asset as Record<string, unknown>);
      }
    }
  }
  return assets;
}

function isExpectedRuntimeFailure(
  runtimeResult: RuntimeResult,
  expect: CaseExpectations | undefined,
): boolean {
  if (runtimeResult.status !== 'failed') return false;
  return (expect?.runtimeResults ?? []).some((expected) => {
    if (expected.status !== 'failed') return false;
    if (expected.runtimeId && expected.runtimeId !== runtimeResult.runtimeId) return false;
    if (expected.errorIncludes) {
      return typeof runtimeResult.error === 'string' && runtimeResult.error.includes(expected.errorIncludes);
    }
    return true;
  });
}

function extensionFromMime(mimeType: unknown): string {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/png') return '.png';
  return '.png';
}

function safeFilePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact';
}

function makeJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function writeExpectedFollowerFailureJob(args: {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly turnId: string;
  readonly runtimeResults: readonly RuntimeResult[];
}): Promise<{ jobId: string; runtimeId: string; pluginId: string; status: 'failed' }> {
  const jobId = makeJobId();
  const timestamp = new Date().toISOString();
  const error =
    args.runtimeResults.find((item) => item.status === 'failed')?.error ??
    `runtime "${args.runtimeId}" completed without emitting a matching background follower event`;
  await args.store.setPluginData({
    id: `${args.sessionId}:${args.pluginId}:_jobs:${jobId}`,
    sessionId: args.sessionId,
    pluginId: args.pluginId,
    namespace: '_jobs',
    key: jobId,
    value: {
      status: 'failed',
      runtimeId: args.runtimeId,
      turnId: args.turnId,
      startedAt: timestamp,
      completedAt: timestamp,
      error,
      runtimeResults: args.runtimeResults,
      reason: 'expected-background-follower-missing',
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return {
    jobId,
    runtimeId: args.runtimeId,
    pluginId: args.pluginId,
    status: 'failed',
  };
}

async function saveImageArtifacts(args: {
  readonly result: RunRuntimeDebugResult;
  readonly pluginRoot: string;
  readonly config: CaseArtifactConfig | undefined;
  readonly mediaStore?: MediaStore;
}): Promise<readonly CaseArtifact[]> {
  const saveImages = args.config?.saveImages;
  if (!saveImages) return [];
  const namespace = saveImages.namespace ?? 'images';
  const field = saveImages.field ?? 'ref';
  const rows = args.result.pluginData[namespace] ?? [];
  const outDir = path.resolve(args.pluginRoot, saveImages.dir ?? 'tests/tmp');
  fs.mkdirSync(outDir, { recursive: true });

  const artifacts: CaseArtifact[] = [];
  for (const row of rows) {
    const value = row.value;
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const maybeRef = record[field];
    const refMime = isMediaRef(maybeRef) ? maybeRef.mime : undefined;
    const mimeType = refMime ?? (typeof record.mimeType === 'string' ? record.mimeType : undefined);
    const ext = extensionFromMime(mimeType);
    const fileName = `${safeFilePart(args.result.caseName ?? args.result.runtimeId)}-${safeFilePart(row.key)}${ext}`;
    const filePath = path.join(outDir, fileName);

    if (isMediaRef(maybeRef) && args.mediaStore) {
      const bytes = await args.mediaStore.get(maybeRef);
      const buffer = bytes instanceof Blob
        ? Buffer.from(await bytes.arrayBuffer())
        : Buffer.from(bytes);
      fs.writeFileSync(filePath, buffer);
      artifacts.push({
        type: 'image',
        namespace,
        key: row.key,
        path: filePath,
        source: 'media',
        mimeType: maybeRef.mime,
      });
      continue;
    }
  }
  return artifacts;
}

function isMediaRef(value: unknown): value is { id: string; mime: string; size: number } {
  if (!value || typeof value !== 'object') return false;
  const ref = value as { id?: unknown; mime?: unknown; size?: unknown };
  return (
    typeof ref.id === 'string' &&
    typeof ref.mime === 'string' &&
    typeof ref.size === 'number'
  );
}

async function runDeferredFollower(args: {
  readonly follower: {
    readonly runtimeId: string;
    readonly pluginId: string;
    readonly triggerEvent: { readonly topic: string; readonly data: Readonly<Record<string, unknown>> };
  };
  readonly sessionId: string;
  readonly locale: string;
  readonly store: DataStore;
  readonly manifests: readonly RuntimeManifest[];
  readonly loadedCache: Map<string, LoadedRuntime>;
  readonly gateway: PluginRuntimeGateway;
  readonly mediaStore: MediaStore;
  readonly utils: PluginRuntimeUtils;
  readonly config: Record<string, unknown>;
  readonly userSettings?: Record<string, unknown>;
}): Promise<{ jobId: string; runtimeId: string; pluginId: string; status: 'done' | 'failed'; result: RuntimeResult }> {
  const manifest = args.manifests.find((item) => item.name === args.follower.runtimeId);
  if (!manifest) throw new Error(`deferred follower not found: ${args.follower.runtimeId}`);
  const loaded = args.loadedCache.get(manifest.name);
  if (!loaded?.handler) throw new Error(`deferred follower has no handler: ${args.follower.runtimeId}`);

  const jobId = makeJobId();
  const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  await args.store.setPluginData({
    id: `${args.sessionId}:${args.follower.pluginId}:_jobs:${jobId}`,
    sessionId: args.sessionId,
    pluginId: args.follower.pluginId,
    namespace: '_jobs',
    key: jobId,
    value: {
      status: 'pending',
      runtimeId: args.follower.runtimeId,
      turnId,
      startedAt,
    },
    createdAt: startedAt,
    updatedAt: startedAt,
  });

  const startMs = Date.now();
  const helperCtx = {
    sessionId: args.sessionId,
    turnId,
    pluginId: args.follower.pluginId,
    runtimeId: args.follower.runtimeId,
  };
  try {
    const isCorePlugin = manifest.pluginType === 'core-plugin';
    const mediaHandle = createRuntimeMediaContext(args.mediaStore, args.utils, {
      sessionId: args.sessionId,
      pluginId: args.follower.pluginId,
    });
    const output = await loaded.handler({
      sessionId: args.sessionId,
      turnId,
      pluginId: args.follower.pluginId,
      playerMessage: '',
      locale: args.locale,
      store: isCorePlugin ? args.store : createFunctionStoreView(args.store, helperCtx),
      completedResults: new Map(),
      config: args.config,
      recursiveCall: async () => {
        throw new Error('recursiveCall is unavailable for test-runtime deferred followers');
      },
      recursionDepth: 0,
      gateway: args.gateway,
      utils: args.utils,
      media: mediaHandle,
      triggerEvent: args.follower.triggerEvent,
      ...(args.userSettings ? { userSettings: args.userSettings } : {}),
      pluginData: createPluginDataWriter(args.store, helperCtx),
      logger: createPluginLogger(args.store, helperCtx),
    });
    const outputRecord = (output ?? {}) as Record<string, unknown>;
    const failed =
      outputRecord.status === 'failed' ||
      (typeof outputRecord.error === 'string' && outputRecord.error.length > 0);
    const completedAt = new Date().toISOString();
    const runtimeResult: RuntimeResult = {
      runtimeId: args.follower.runtimeId,
      pluginId: args.follower.pluginId,
      runId: turnId,
      turnId,
      status: failed ? 'failed' : 'success',
      durationMs: Date.now() - startMs,
      output: outputRecord,
      toolCalls: [],
      timestamp: completedAt,
      ...(failed ? { error: typeof outputRecord.error === 'string' ? outputRecord.error : 'runtime reported failure' } : {}),
    };
    const processOpts = {
      capabilities: manifest.capabilities ?? [],
    };
    await processRuntimeResult(
      runtimeResult,
      args.store,
      args.sessionId,
      manifest.outputKind ?? 'plugin',
      processOpts,
    );
    await args.store.setPluginData({
      id: `${args.sessionId}:${args.follower.pluginId}:_jobs:${jobId}`,
      sessionId: args.sessionId,
      pluginId: args.follower.pluginId,
      namespace: '_jobs',
      key: jobId,
      value: {
        status: failed ? 'failed' : 'done',
        runtimeId: args.follower.runtimeId,
        turnId,
        startedAt,
        completedAt,
        durationMs: runtimeResult.durationMs,
        ...(runtimeResult.error ? { error: runtimeResult.error } : {}),
        runtimeResults: [runtimeResult],
      },
      createdAt: startedAt,
      updatedAt: completedAt,
    });
    return {
      jobId,
      runtimeId: args.follower.runtimeId,
      pluginId: args.follower.pluginId,
      status: failed ? 'failed' : 'done',
      result: runtimeResult,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const runtimeResult: RuntimeResult = {
      runtimeId: args.follower.runtimeId,
      pluginId: args.follower.pluginId,
      runId: turnId,
      turnId,
      status: 'failed',
      durationMs: Date.now() - startMs,
      output: {},
      toolCalls: [],
      timestamp: completedAt,
      error: error instanceof Error ? error.message : String(error),
    };
    await args.store.setPluginData({
      id: `${args.sessionId}:${args.follower.pluginId}:_jobs:${jobId}`,
      sessionId: args.sessionId,
      pluginId: args.follower.pluginId,
      namespace: '_jobs',
      key: jobId,
      value: {
        status: 'failed',
        runtimeId: args.follower.runtimeId,
        turnId,
        startedAt,
        completedAt,
        error: runtimeResult.error,
        runtimeResults: [runtimeResult],
      },
      createdAt: startedAt,
      updatedAt: completedAt,
    });
    return {
      jobId,
      runtimeId: args.follower.runtimeId,
      pluginId: args.follower.pluginId,
      status: 'failed',
      result: runtimeResult,
    };
  }
}

export async function runRuntimeDebug(
  options: RunRuntimeDebugOptions,
): Promise<RunRuntimeDebugResult> {
  const runtimeId = options.runtimeId;
  if (!runtimeId) throw new Error('runtimeId is required');
  const pluginId = options.pluginId ?? pluginIdFromRuntime(runtimeId);
  const pluginsDir = expandPath(options.pluginsDir ?? defaultPluginsDir());
  const sessionId = options.sessionId ?? `debug-${Date.now().toString(36)}`;
  const turnId = `turn-${Date.now().toString(36)}`;
  const locale = options.locale ?? 'zh-CN';

  const discoveries = await discoverPlugins(pluginsDir);
  const discovery = discoveries.find((d) => d.id === pluginId);
  if (!discovery) {
    throw new Error(`plugin "${pluginId}" not found in ${pluginsDir}`);
  }

  const parsed = await loadPluginManifest(discovery);
  const rawManifests = parsed.map((p) => p.manifest);
  const manifests = options.ignoreUpstreams
    ? rawManifests.map((m) => ({ ...m, upstreamRequired: undefined }))
    : rawManifests;
  const target = manifests.find((m) => m.name === runtimeId);
  if (!target) {
    throw new Error(`runtime "${runtimeId}" not found in plugin "${pluginId}"`);
  }

  const loadedCache = new Map<string, LoadedRuntime>();
  for (const manifest of rawManifests) {
    loadedCache.set(manifest.name, await loadRuntime(discovery, manifest.name, locale));
  }

  const store = createMemoryStore();
  const mediaStore = options.mediaStore ?? createMemoryMediaStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: sessionId,
    locale,
    status: 'active',
    turnCount: 1,
    preGameCompleted: [],
    activePlugins: [pluginId],
    createdAt: now,
    updatedAt: now,
  });

  const toolMap = new Map<string, ToolModule>();
  for (const t of builtinUITools) toolMap.set(t.name, t);
  toolMap.set(suspendTool.name, suspendTool);
  toolMap.set(runtimeDoneTool.name, runtimeDoneTool);
  for (const t of createPluginDataTools(store)) toolMap.set(t.name, t);
  for (const t of createCharacterTools(store, { findWorldDataPluginId: () => pluginId })) {
    toolMap.set(t.name, t);
  }
  for (const t of await loadLocalTools(discovery, manifests)) {
    toolMap.set(t.name, t);
  }

  const llm = new DebugLLM(options);
  const liveAdapters = options.mode === 'live' ? makeLiveAdapters() : undefined;
  const result = await executeTurn(
    {
      sessionId,
      turnId,
      playerMessage: options.message ?? '',
      locale,
      manualTrigger: {
        runtimeId,
        ...(options.payload ? { payload: options.payload } : {}),
      },
      ...(options.userSettings
        ? { userSettings: { [pluginId]: options.userSettings } }
        : {}),
    } satisfies TurnInput,
    manifests,
    {
      loadRuntime: async (manifest) => loadedCache.get(manifest.name),
      llm: liveAdapters?.llm ?? llm,
      gateway: liveAdapters?.gateway ?? makeGateway(options),
      utils: PLUGIN_UTILS,
      mediaStore,
      getConfig: () => options.config ?? {},
      store,
      toolExecutor: createToolExecutor({
        findTool: (name) => toolMap.get(name),
        store,
      }),
    },
  );

  const outputKindMap = new Map(manifests.map((m) => [m.name, m.outputKind ?? 'plugin']));
  const runtimeCapabilitiesMap = new Map(
    manifests.map((m): [string, readonly string[]] => [m.name, m.capabilities ?? []]),
  );
  for (const runtimeResult of result.runtimeResults) {
    const processOpts = {
      capabilities: runtimeCapabilitiesMap.get(runtimeResult.runtimeId) ?? [],
    };
    await processRuntimeResult(
      runtimeResult,
      store,
      sessionId,
      outputKindMap.get(runtimeResult.runtimeId) ?? 'plugin',
      processOpts,
    );
  }

  const jobs: Array<{ jobId: string; runtimeId: string; pluginId: string; status: 'done' | 'failed' }> = [];
  const followerResults: RuntimeResult[] = [];
  for (const follower of result.deferredFollowers ?? []) {
    const job = await runDeferredFollower({
      follower,
      sessionId,
      locale,
      store,
      manifests,
      loadedCache,
      gateway: liveAdapters?.gateway ?? makeGateway(options),
      mediaStore,
      utils: PLUGIN_UTILS,
      config: options.config ?? {},
      ...(options.userSettings ? { userSettings: options.userSettings } : {}),
    });
    jobs.push({
      jobId: job.jobId,
      runtimeId: job.runtimeId,
      pluginId: job.pluginId,
      status: job.status,
    });
    followerResults.push(job.result);
  }

  if (options.expectsBackgroundFollower === true && (result.deferredFollowers ?? []).length === 0) {
    jobs.push(await writeExpectedFollowerFailureJob({
      store,
      sessionId,
      pluginId,
      runtimeId,
      turnId,
      runtimeResults: result.runtimeResults,
    }));
  }

  const pluginData = await listPluginDataByNamespace(store, sessionId, pluginId);
  const logs = pluginData._logs ?? [];
  const allRuntimeResults = [...result.runtimeResults, ...followerResults];
  const baseResult = {
    status: 'ok' as const,
    mode: options.mode ?? 'mock' as const,
    ...(options.caseName ? { caseName: options.caseName } : {}),
    sessionId,
    turnId,
    pluginId,
    runtimeId,
    runtimeResults: allRuntimeResults,
    jobs,
    deferredFollowers: result.deferredFollowers ?? [],
    pluginData,
    logs,
    llmCalls: llm.calls,
  };

  return baseResult;
}

function caseFilesFor(pluginRoot: string): readonly string[] {
  return [
    path.join(pluginRoot, 'tests', 'runtime-cases.json'),
    path.join(pluginRoot, 'covel.test.json'),
  ];
}

function parseCaseFile(file: string): readonly RuntimeCase[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (Array.isArray(parsed)) return parsed as readonly RuntimeCase[];
  if (parsed && typeof parsed === 'object') {
    return ((parsed as RuntimeCaseFile).cases ?? []);
  }
  return [];
}

export async function runRuntimeCases(
  options: RunRuntimeDebugOptions,
): Promise<RunRuntimeCasesResult> {
  const pluginId = options.pluginId;
  if (!pluginId) throw new Error('pluginId is required');
  const pluginsDir = expandPath(options.pluginsDir ?? defaultPluginsDir());
  const discoveries = await discoverPlugins(pluginsDir);
  const discovery = discoveries.find((item) => item.id === pluginId);
  if (!discovery) throw new Error(`plugin "${pluginId}" not found in ${pluginsDir}`);

  const caseFile = caseFilesFor(discovery.rootPath).find((file) => fs.existsSync(file));
  if (!caseFile) {
    const manifests = (await loadPluginManifest(discovery)).map((item) => item.manifest);
    if (manifests.some((item) => item.name === pluginId)) {
      const result = await runRuntimeDebug({
        ...options,
        runtimeId: pluginId,
        pluginId,
      });
      return {
        status: 'ok',
        mode: options.mode ?? 'mock',
        pluginId,
        cases: [{
          name: pluginId,
          status: result.runtimeResults.some((item) => item.status === 'failed') ? 'failed' : 'passed',
          result,
        }],
      };
    }
    throw new Error(`plugin "${pluginId}" has no tests/runtime-cases.json or covel.test.json`);
  }
  const activeMode = options.mode ?? 'mock';
  const cases = parseCaseFile(caseFile).filter((item) => {
    if (options.caseName && item.name !== options.caseName) return false;
    const caseMode = item.mode ?? 'both';
    return caseMode === 'both' || caseMode === activeMode;
  });
  if (cases.length === 0) {
    const reason = options.caseName
      ? `case "${options.caseName}" not found or not enabled for mode "${activeMode}"`
      : `no cases enabled for mode "${activeMode}"`;
    throw new Error(`${reason} in ${caseFile}`);
  }

  const results: Array<RunRuntimeCasesResult['cases'][number]> = [];
  for (const testCase of cases) {
    const mediaStore = createMemoryMediaStore();
    const result = await runRuntimeDebug({
      ...options,
      runtimeId: testCase.runtimeId,
      pluginId: testCase.pluginId ?? pluginId,
      caseName: testCase.name,
      message: testCase.message ?? options.message,
      payload: testCase.payload ?? options.payload,
      config: testCase.config ?? options.config,
      userSettings: testCase.userSettings ?? options.userSettings,
      llmResponse: testCase.llmResponse ?? options.llmResponse,
      llmResponses: testCase.llmResponses ?? options.llmResponses,
      llmContent: testCase.llmContent ?? options.llmContent,
      llmObject: testCase.llmObject ?? options.llmObject,
      mockPresetId: testCase.mockPresetId ?? options.mockPresetId,
      ignoreUpstreams: testCase.ignoreUpstreams ?? options.ignoreUpstreams,
      expectsBackgroundFollower: testCase.expectsBackgroundFollower ?? options.expectsBackgroundFollower,
      mediaStore,
    });
    const assertions = evaluateExpectations(testCase.expect, result);
    const artifacts = await saveImageArtifacts({
      result,
      pluginRoot: discovery.rootPath,
      config: testCase.artifacts,
      mediaStore,
    });
    const withAssertions = { ...result, artifacts, assertions };
    const runtimeFailed = withAssertions.runtimeResults.some(
      (item) => item.status === 'failed' && !isExpectedRuntimeFailure(item, testCase.expect),
    );
    const assertionFailed = assertions.some((item) => item.status === 'failed');
    results.push({
      name: testCase.name,
      status: runtimeFailed || assertionFailed ? 'failed' : 'passed',
      result: withAssertions,
    });
  }

  return {
    status: 'ok',
    mode: options.mode ?? 'mock',
    pluginId,
    cases: results,
  };
}
