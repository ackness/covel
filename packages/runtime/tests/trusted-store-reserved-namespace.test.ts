/**
 * Trusted (builtin/official) function-runtime handlers receive the full
 * DataStore because their logic implements framework primitives — but they
 * are still plugin code. `_`-prefixed plugin-data namespaces (`_jobs`,
 * `_logs`) are framework bookkeeping, and a stray trusted-handler write into
 * them would corrupt background-job or log-ring state. These tests pin that
 * the trusted store handle blocks reserved-namespace writes while leaving
 * reads and normal-namespace writes untouched. Framework writers (the job
 * runner, the runtime logger) call the raw store directly and are unaffected.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import type { FunctionHandler } from "@covel/plugin-loader";
import { executeFunctionRuntime } from "../src/function-runtime/turn-function-runtime.js";
import { processRuntimeResult } from "../src/session/session-runtime-result.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";

const SESSION_ID = "sess-trusted-ns";

function makeManifest(): RuntimeManifest {
  return {
    name: "official-plugin/worker",
    pluginId: "official-plugin",
    description: "trusted function runtime",
    priority: 500,
    trigger: { type: "auto" },
    runtimeType: "function",
  } as RuntimeManifest;
}

async function runTrustedHandler(
  store: DataStore,
  handler: FunctionHandler,
): Promise<RuntimeResult> {
  const manifest = makeManifest();
  const input: TurnInput = {
    sessionId: SESSION_ID,
    turnId: "turn-1",
    playerMessage: "hello",
  };
  return executeFunctionRuntime({
    manifest,
    input,
    loaded: { manifest, promptTemplate: "", handler },
    completedResults: new Map(),
    deps: {
      store,
      getPluginSource: () => "official",
    } as unknown as TurnExecutorDeps,
    hookPipeline: undefined,
    triggerEvent: undefined,
    createRecursiveCall: () => () =>
      Promise.reject(new Error("recursiveCall not wired in this test")),
    recursionDepth: 0,
    startTime: Date.now(),
    runId: "run-1",
    timeoutMs: 5_000,
  });
}

describe("trusted function-runtime store handle", () => {
  it("rejects writes into framework-reserved `_` namespaces", async () => {
    const store = createMemoryStore();
    let writeError: unknown;

    await runTrustedHandler(store, async (ctx) => {
      const handlerStore = ctx.store as DataStore;
      try {
        await handlerStore.setPluginData({
          id: `${SESSION_ID}:official-plugin:_jobs:forged`,
          sessionId: SESSION_ID,
          pluginId: "official-plugin",
          namespace: "_jobs",
          key: "forged",
          value: { status: "done" },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        writeError = err;
      }
      return { proposals: [] };
    });

    expect(writeError).toBeInstanceOf(Error);
    expect((writeError as Error).message).toContain("reserved");
    const rows = await store.listPluginData(
      SESSION_ID,
      "official-plugin",
      "_jobs",
    );
    expect(rows).toHaveLength(0);
  });

  it("still allows normal-namespace writes and reserved-namespace reads", async () => {
    const store = createMemoryStore();
    // Framework-owned row written through the raw store (job-runner style).
    await store.setPluginData({
      id: `${SESSION_ID}:official-plugin:_jobs:job-1`,
      sessionId: SESSION_ID,
      pluginId: "official-plugin",
      namespace: "_jobs",
      key: "job-1",
      value: { status: "pending" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let observedJob: unknown;
    const result = await runTrustedHandler(store, async (ctx) => {
      const handlerStore = ctx.store as DataStore;
      const row = await handlerStore.getPluginData(
        SESSION_ID,
        "official-plugin",
        "_jobs",
        "job-1",
      );
      observedJob = row?.value;
      await handlerStore.setPluginData({
        id: `${SESSION_ID}:official-plugin:state:progress`,
        sessionId: SESSION_ID,
        pluginId: "official-plugin",
        namespace: "state",
        key: "progress",
        value: { step: 1 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return { proposals: [] };
    });

    // Reserved-namespace read passes through to the store unchanged.
    expect(observedJob).toEqual({ status: "pending" });

    // DELIBERATE CHANGE (effects isolation): the normal-namespace write is now
    // buffered, not written during execution — the store is untouched until
    // the result's pending proposals commit through the pipeline.
    expect(
      await store.getPluginData(
        SESSION_ID,
        "official-plugin",
        "state",
        "progress",
      ),
    ).toBeNull();

    await processRuntimeResult(
      {
        pluginId: "official-plugin",
        runtimeId: "official-plugin/worker",
        turnId: "turn-1",
        status: result.status,
        output: result.output,
      },
      store,
      SESSION_ID,
      "plugin",
    );

    const row = await store.getPluginData(
      SESSION_ID,
      "official-plugin",
      "state",
      "progress",
    );
    expect(row?.value).toEqual({ step: 1 });
  });
});
