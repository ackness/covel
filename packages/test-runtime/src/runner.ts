import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
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
} from "@covel/ai-provider";
import {
  providerApiKeysFromEnv,
  providerIdToApiKeyEnvName,
  readRuntimeEnv,
} from "@covel/shared";
import {
  type PluginRuntimeGateway,
  type PluginRuntimeUtils,
} from "@covel/plugin-loader";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store";
import type { RunRuntimeDebugOptions } from "./types.js";
import {
  createToolExecutor,
  createGatewayAdapter,
  createPluginRuntimeGateway,
  executeTurn,
  processRuntimeResult,
  type LLMAdapter,
  type LLMResponse,
} from "@covel/runtime";
import { MockLLM, type MockLLMCall } from "@covel/plugin-test-utils";
import {
  builtinUITools,
  createCharacterTools,
  createPluginDataTools,
  runtimeDoneTool,
  suspendTool,
  type ToolModule,
} from "@covel/tools";
import {
  evaluateExpectations,
  isExpectedRuntimeFailure,
  listPluginDataByNamespace,
  saveImageArtifacts,
  type CaseArtifact,
  type CaseArtifactConfig,
  type CaseAssertion,
  type CaseExpectations,
} from "./reporting.js";
import {
  buildCaseDebugOptions,
  caseFilesFor,
  filterRuntimeCases,
  parseCaseFile,
} from "./cases.js";
import {
  runDeferredFollower,
  writeExpectedFollowerFailureJob,
} from "./execution.js";
import {
  defaultPluginsDir,
  discoverPlugin,
  expandPath,
  loadRuntimeBundle,
  loadRuntimeManifests,
  pluginIdFromRuntime,
} from "./runtime-loading.js";

export type { RunRuntimeDebugOptions };

export interface RunRuntimeDebugResult {
  readonly status: "ok";
  readonly mode: "mock" | "live";
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
    readonly status: "done" | "failed";
  }[];
  readonly deferredFollowers: readonly {
    readonly runtimeId: string;
    readonly pluginId: string;
    readonly triggerEvent: {
      readonly topic: string;
      readonly data: Readonly<Record<string, unknown>>;
    };
  }[];
  readonly pluginData: Readonly<
    Record<
      string,
      ReadonlyArray<{ readonly key: string; readonly value: unknown }>
    >
  >;
  readonly logs: ReadonlyArray<{
    readonly key: string;
    readonly value: unknown;
  }>;
  readonly llmCalls: readonly unknown[];
  readonly artifacts?: readonly CaseArtifact[];
  readonly assertions?: readonly CaseAssertion[];
}

export interface RunRuntimeCasesResult {
  readonly status: "ok";
  readonly mode: "mock" | "live";
  readonly pluginId: string;
  readonly cases: readonly {
    readonly name: string;
    readonly status: "passed" | "failed";
    readonly result: RunRuntimeDebugResult;
  }[];
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

function buildMockLlm(options: RunRuntimeDebugOptions): MockLLM {
  const responses = normalizeLlmResponses(options);
  return new MockLLM({
    responses,
    // Original DebugLLM stayed on the last response after exhausting the
    // queue; mirror that by using the final response as the fallback.
    defaultResponse: responses[responses.length - 1],
    captureMessages: options.showPrompts === true,
  });
}

function serializeLlmCalls(
  calls: readonly MockLLMCall[],
  showPrompts: boolean,
): readonly unknown[] {
  return calls.map((call) => ({
    callIndex: call.callIndex,
    model: call.model,
    toolNames: call.toolNames ?? [],
    responseFormat: call.responseFormat,
    ...(showPrompts ? { messages: call.messages } : {}),
  }));
}

function normalizeLlmResponses(
  options: RunRuntimeDebugOptions,
): readonly LLMResponse[] {
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
    : (options.llmContent ?? '{"ok":true}');
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function normalizeRawLlmResponse(raw: Record<string, unknown>): LLMResponse {
  return {
    content:
      typeof raw.content === "string" || raw.content === null
        ? raw.content
        : "",
    toolCalls: Array.isArray(raw.toolCalls)
      ? (raw.toolCalls as LLMResponse["toolCalls"])
      : [],
    finishReason:
      raw.finishReason === "tool_calls" ||
      raw.finishReason === "length" ||
      raw.finishReason === "error"
        ? raw.finishReason
        : "stop",
    usage: isUsage(raw.usage) ? raw.usage : { inputTokens: 1, outputTokens: 1 },
  };
}

function isUsage(
  value: unknown,
): value is { inputTokens: number; outputTokens: number } {
  if (!value || typeof value !== "object") return false;
  const usage = value as { inputTokens?: unknown; outputTokens?: unknown };
  return (
    typeof usage.inputTokens === "number" &&
    typeof usage.outputTokens === "number"
  );
}

function makeGateway(options: RunRuntimeDebugOptions): PluginRuntimeGateway {
  return {
    async generateText(input) {
      return {
        text:
          input.prompt ??
          input.messages?.map((m) => m.content).join("\n") ??
          "",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async generateObject<T = unknown>() {
      return {
        object: { ok: true } as T,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    resolveSlot() {
      // Mock harness: return a synthetic slot config so plugins that own
      // their own wire (e.g. openai-image-gen) can be unit-tested without
      // a live llm.toml. Live mode replaces this whole gateway with a
      // real one via createPluginRuntimeGateway().
      return {
        presetId: options.mockPresetId ?? "mock-image",
        provider: "mock",
        protocol: "openai-chat-v1",
        baseUrl: "mock://covel-test-runtime/v1",
        apiKey: "mock-api-key",
        model: "mock-model",
        tag: "image",
        metadata: {},
      };
    },
  };
}

function loadKeysEnvInto(target: NodeJS.ProcessEnv): void {
  const env = readRuntimeEnv(target);
  const covelHome = env.covelHome ?? path.join(os.homedir(), ".covel");
  const file = path.join(covelHome, "keys.env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
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

function configureSlots(
  config: AiConfig,
): ReturnType<typeof createSlotRegistry> {
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
        tag: preset.tag ?? "text",
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
    env.userConfigDir
      ? path.resolve(env.userConfigDir, "model-db.json")
      : undefined,
    BUNDLED_MODEL_DB_PATH,
  ].filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      const data = JSON.parse(raw) as Parameters<typeof createModelDatabase>[0];
      setModelDatabase(createModelDatabase(data));
      return;
    } catch {
      // Try the next candidate.
    }
  }
}

function makeLiveAdapters(): {
  llm: LLMAdapter;
  gateway: PluginRuntimeGateway;
} {
  loadKeysEnvInto(process.env);
  loadModelDb();

  const env = readRuntimeEnv();
  const covelHome = env.covelHome ?? path.join(os.homedir(), ".covel");
  const llmTomlCandidates = [
    env.llmToml ? path.resolve(env.llmToml) : undefined,
    path.join(covelHome, "llm.toml"),
    path.resolve(process.cwd(), "llm.toml"),
  ].filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );

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
  const aiGateway = createGateway({
    providerRegistry,
    presetRegistry,
    slotRegistry,
  });
  const apiKeys = providerApiKeysFromEnv(process.env);
  return {
    llm: createGatewayAdapter(aiGateway, { apiKeys }),
    gateway: createPluginRuntimeGateway(aiGateway, { apiKeys }),
  };
}

export async function runRuntimeDebug(
  options: RunRuntimeDebugOptions,
): Promise<RunRuntimeDebugResult> {
  const runtimeId = options.runtimeId;
  if (!runtimeId) throw new Error("runtimeId is required");
  const pluginId = options.pluginId ?? pluginIdFromRuntime(runtimeId);
  const pluginsDir = expandPath(options.pluginsDir ?? defaultPluginsDir());
  const sessionId = options.sessionId ?? `debug-${Date.now().toString(36)}`;
  const turnId = `turn-${Date.now().toString(36)}`;
  const locale = options.locale ?? "zh-CN";
  const store = createMemoryStore();
  const mediaStore = options.mediaStore ?? createMemoryMediaStore();

  const { discovery, manifests, loadedCache, localTools } =
    await loadRuntimeBundle({
      pluginsDir,
      pluginId,
      runtimeId,
      locale,
      ignoreUpstreams: options.ignoreUpstreams,
      store,
    });

  const now = new Date().toISOString();
  await store.createSession({
    id: sessionId,
    locale,
    status: "active",
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
  for (const t of createCharacterTools(store, {
    findWorldDataPluginId: () => pluginId,
  })) {
    toolMap.set(t.name, t);
  }
  for (const t of localTools) {
    toolMap.set(t.name, t);
  }

  const llm = buildMockLlm(options);
  const liveAdapters = options.mode === "live" ? makeLiveAdapters() : undefined;
  const result = await executeTurn(
    {
      sessionId,
      turnId,
      playerMessage: options.message ?? "",
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
      getPluginSource: () => discovery.source,
      getConfig: () => options.config ?? {},
      store,
      toolExecutor: createToolExecutor({
        findTool: (name) => toolMap.get(name),
        store,
      }),
    },
  );

  const outputKindMap = new Map(
    manifests.map((m) => [m.name, m.outputKind ?? "plugin"]),
  );
  const runtimeCapabilitiesMap = new Map(
    manifests.map((m): [string, readonly string[]] => [
      m.name,
      m.capabilities ?? [],
    ]),
  );
  for (const runtimeResult of result.runtimeResults) {
    const processOpts = {
      capabilities: runtimeCapabilitiesMap.get(runtimeResult.runtimeId) ?? [],
    };
    await processRuntimeResult(
      runtimeResult,
      store,
      sessionId,
      outputKindMap.get(runtimeResult.runtimeId) ?? "plugin",
      processOpts,
    );
  }

  const jobs: Array<{
    jobId: string;
    runtimeId: string;
    pluginId: string;
    status: "done" | "failed";
  }> = [];
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

  if (
    options.expectsBackgroundFollower === true &&
    (result.deferredFollowers ?? []).length === 0
  ) {
    jobs.push(
      await writeExpectedFollowerFailureJob({
        store,
        sessionId,
        pluginId,
        runtimeId,
        turnId,
        runtimeResults: result.runtimeResults,
      }),
    );
  }

  const pluginData = await listPluginDataByNamespace(
    store,
    sessionId,
    pluginId,
  );
  const logs = pluginData._logs ?? [];
  const allRuntimeResults = [...result.runtimeResults, ...followerResults];
  const baseResult = {
    status: "ok" as const,
    mode: options.mode ?? ("mock" as const),
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
    llmCalls: serializeLlmCalls(llm.calls, options.showPrompts === true),
  };

  return baseResult;
}

export async function runRuntimeCases(
  options: RunRuntimeDebugOptions,
): Promise<RunRuntimeCasesResult> {
  const pluginId = options.pluginId;
  if (!pluginId) throw new Error("pluginId is required");
  const pluginsDir = expandPath(options.pluginsDir ?? defaultPluginsDir());
  const discovery = await discoverPlugin(pluginsDir, pluginId);

  const caseFile = caseFilesFor(discovery.rootPath).find((file) =>
    fs.existsSync(file),
  );
  if (!caseFile) {
    const manifests = await loadRuntimeManifests(discovery);
    if (manifests.some((item) => item.name === pluginId)) {
      const result = await runRuntimeDebug({
        ...options,
        runtimeId: pluginId,
        pluginId,
      });
      return {
        status: "ok",
        mode: options.mode ?? "mock",
        pluginId,
        cases: [
          {
            name: pluginId,
            status: result.runtimeResults.some(
              (item) => item.status === "failed",
            )
              ? "failed"
              : "passed",
            result,
          },
        ],
      };
    }
    throw new Error(
      `plugin "${pluginId}" has no tests/runtime-cases.json or covel.test.json`,
    );
  }
  const activeMode = options.mode ?? "mock";
  const cases = filterRuntimeCases({
    cases: parseCaseFile(caseFile),
    caseName: options.caseName,
    mode: activeMode,
    caseFile,
  });

  const results: Array<RunRuntimeCasesResult["cases"][number]> = [];
  for (const testCase of cases) {
    const mediaStore = createMemoryMediaStore();
    const result = await runRuntimeDebug(
      buildCaseDebugOptions({
        base: options,
        testCase,
        pluginId,
        mediaStore,
      }),
    );
    const assertions = evaluateExpectations(testCase.expect, result);
    const artifacts = await saveImageArtifacts({
      result,
      pluginRoot: discovery.rootPath,
      config: testCase.artifacts,
      mediaStore,
    });
    const withAssertions = { ...result, artifacts, assertions };
    const runtimeFailed = withAssertions.runtimeResults.some(
      (item) =>
        item.status === "failed" &&
        !isExpectedRuntimeFailure(item, testCase.expect),
    );
    const assertionFailed = assertions.some((item) => item.status === "failed");
    results.push({
      name: testCase.name,
      status: runtimeFailed || assertionFailed ? "failed" : "passed",
      result: withAssertions,
    });
  }

  return {
    status: "ok",
    mode: options.mode ?? "mock",
    pluginId,
    cases: results,
  };
}
