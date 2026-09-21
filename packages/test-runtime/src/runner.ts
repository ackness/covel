import fs from "node:fs";
import {
  DEFAULT_LOCALE,
  type RuntimeResult,
  type TurnInput,
} from "@covel/shared";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import type { RunRuntimeDebugOptions } from "./types.js";
import {
  createToolExecutor,
  executeTurn,
  snapshotUserSettings,
  type TurnExecutorDeps,
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
  hasUnexpectedRunFailure,
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
  commitDebugExecution,
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
  readonly commitStatus: "committed" | "failed";
  readonly commitError?: string;
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
  /** Further background work discovered while running the first follower layer. */
  readonly pendingDeferredFollowers: readonly {
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
  const locale = options.locale ?? DEFAULT_LOCALE;
  const store = createMemoryStore();
  const mediaStore = options.mediaStore ?? createMemoryMediaStore();

  const { discovery, manifests, loadedCache, entryTools, services } =
    await loadRuntimeBundle({
      pluginsDir,
      pluginId,
      runtimeId,
      locale,
      ignoreUpstreams: options.ignoreUpstreams,
    });

  const now = new Date().toISOString();
  await store.createSession({
    id: sessionId,
    locale,
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
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
  // Entry-registered plugin tools last: a name collision means the plugin is
  // shadowing a framework tool, which the server bootstrap rejects — surface
  // it here rather than silently running a different implementation.
  for (const t of entryTools) {
    if (toolMap.has(t.name)) {
      throw new Error(
        `entry registered tool "${t.name}", which collides with a framework tool`,
      );
    }
    toolMap.set(t.name, t);
  }
  const llm = buildMockLlm(options);
  const liveAdapters = options.mode === "live" ? makeLiveAdapters() : undefined;
  const deps = {
    loadRuntime: async (manifest) => loadedCache.get(manifest.name),
    llm: liveAdapters?.llm ?? llm,
    services,
    gateway: liveAdapters?.gateway ?? makeGateway(options),
    utils: PLUGIN_UTILS,
    mediaStore,
    getPluginSource: () => discovery.source,
    store,
    toolExecutor: createToolExecutor({
      findTool: (name) => toolMap.get(name),
      store,
    }),
  } satisfies TurnExecutorDeps;
  const userSettings = snapshotUserSettings(
    options.userSettings ? { [pluginId]: options.userSettings } : undefined,
  );
  const result = await executeTurn(
    {
      sessionId,
      turnId,
      playerMessage: options.message ?? "",
      origin: "manual",
      locale,
      manualTrigger: {
        runtimeId,
        ...(options.payload ? { payload: options.payload } : {}),
      },
      userSettings,
    } satisfies TurnInput,
    manifests,
    deps,
  );

  const commit = await commitDebugExecution({
    turn: result,
    manifests,
    deps,
    locale,
    userSettings,
    detached: false,
  });
  const committedFollowers =
    commit.status === "committed" ? (result.deferredFollowers ?? []) : [];

  const jobs: Array<{
    jobId: string;
    runtimeId: string;
    pluginId: string;
    status: "done" | "failed";
  }> = [];
  const followerResults: RuntimeResult[] = [];
  const pendingDeferredFollowers: RunRuntimeDebugResult["pendingDeferredFollowers"][number][] =
    [];
  for (const follower of committedFollowers) {
    const job = await runDeferredFollower({
      follower,
      sessionId,
      locale,
      manifests,
      deps,
      ...(userSettings?.[pluginId]
        ? { userSettings: userSettings[pluginId] }
        : {}),
    });
    jobs.push({
      jobId: job.jobId,
      runtimeId: job.runtimeId,
      pluginId: job.pluginId,
      status: job.status,
    });
    followerResults.push(...job.runtimeResults);
    pendingDeferredFollowers.push(...job.deferredFollowers);
  }

  if (
    options.expectsBackgroundFollower === true &&
    commit.status === "committed" &&
    committedFollowers.length === 0
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
  const allRuntimeResults = [
    ...result.runtimeResults,
    ...(result.nestedRuntimeResults ?? []),
    ...followerResults,
  ];
  const baseResult = {
    status: "ok" as const,
    mode: options.mode ?? ("mock" as const),
    ...(options.caseName ? { caseName: options.caseName } : {}),
    sessionId,
    turnId,
    pluginId,
    runtimeId,
    runtimeResults: allRuntimeResults,
    commitStatus: commit.status,
    ...(commit.status === "failed"
      ? {
          commitError:
            commit.error ??
            commit.failedProposals[0]?.error ??
            "Execution commit failed",
        }
      : {}),
    jobs,
    deferredFollowers: committedFollowers,
    pendingDeferredFollowers,
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
            status: hasUnexpectedRunFailure(result) ? "failed" : "passed",
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
    const runFailed = hasUnexpectedRunFailure(withAssertions, testCase.expect);
    const assertionFailed = assertions.some((item) => item.status === "failed");
    results.push({
      name: testCase.name,
      status: runFailed || assertionFailed ? "failed" : "passed",
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
