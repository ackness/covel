import fs from "node:fs";
import type { RuntimeResult, TurnInput } from "@covel/shared";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store";
import type { RunRuntimeDebugOptions } from "./types.js";
import {
  createToolExecutor,
  executeTurn,
  processRuntimeResult,
} from "@covel/runtime";
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
  type CaseAssertion,
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
import { buildMockLlm, serializeLlmCalls } from "./llm-setup.js";
import {
  PLUGIN_UTILS,
  makeGateway,
  makeLiveAdapters,
} from "./gateway-setup.js";

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

  const { discovery, manifests, loadedCache } = await loadRuntimeBundle({
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
