/**
 * `_`-prefixed plugin-data namespaces (`_jobs`, `_logs`) are framework
 * bookkeeping, and a stray handler write into them would corrupt
 * background-job or log-ring state. These tests pin that `ctx.pluginData`
 * blocks reserved-namespace writes while leaving reads and normal-namespace
 * writes untouched, for a bundled plugin as for any other. Framework writers
 * (the job runner, the runtime logger) call the raw store directly and are
 * unaffected.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import type { FunctionHandler } from "@covel/plugin-loader";
import { executeFunctionRuntime } from "../src/function-runtime/turn-function-runtime.js";
import { processRuntimeResult } from "../src/session/session-runtime-result.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";

const SESSION_ID = "sess-reserved-ns";

function makeManifest(): RuntimeManifest {
  return {
    name: "builtin-plugin/worker",
    pluginId: "builtin-plugin",
    description: "bundled function runtime",
    stage: "narrative",
    trigger: { type: "auto" },
    runtimeType: "function",
  } as RuntimeManifest;
}

async function runBundledHandler(
  store: DataStore,
  handler: FunctionHandler,
): Promise<RuntimeResult> {
  const manifest = makeManifest();
  const input: TurnInput = {
    origin: "player",
    sessionId: SESSION_ID,
    turnId: "turn-1",
    playerMessage: "hello",
  };
  return executeFunctionRuntime({
    executionContext: {
      executionId: crypto.randomUUID(),
      origin: "manual",
      countPolicy: "none",
    },
    manifest,
    input,
    loaded: { manifest, promptTemplate: "", handler },
    deps: {
      store,
      getPluginSource: () => "builtin",
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

describe("plugin-data handle of a bundled function runtime", () => {
  it("rejects writes into framework-reserved `_` namespaces", async () => {
    const store = createMemoryStore();
    let writeError: unknown;

    await runBundledHandler(store, async (ctx) => {
      try {
        await ctx.pluginData!.set("_jobs", "forged", { status: "done" });
      } catch (err) {
        writeError = err;
      }
      return { outcome: "success", value: { proposals: [] } };
    });

    expect(writeError).toBeInstanceOf(Error);
    expect((writeError as Error).message).toContain("reserved");
    const rows = await store.listPluginData(
      SESSION_ID,
      "builtin-plugin",
      "_jobs",
    );
    expect(rows).toHaveLength(0);
  });

  it("still allows normal-namespace writes and reserved-namespace reads", async () => {
    const store = createMemoryStore();
    // Framework-owned row written through the raw store (job-runner style).
    await store.setPluginData({
      id: `${SESSION_ID}:builtin-plugin:_jobs:job-1`,
      sessionId: SESSION_ID,
      pluginId: "builtin-plugin",
      namespace: "_jobs",
      key: "job-1",
      value: { status: "pending" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let observedJob: unknown;
    const result = await runBundledHandler(store, async (ctx) => {
      const row = await ctx.store.getPluginData("_jobs", "job-1");
      observedJob = row?.value;
      await ctx.pluginData!.set("state", "progress", { step: 1 });
      return { outcome: "success", value: { proposals: [] } };
    });

    // Reserved-namespace read passes through to the store unchanged.
    expect(observedJob).toEqual({ status: "pending" });

    // DELIBERATE CHANGE (effects isolation): the normal-namespace write is now
    // buffered, not written during execution — the store is untouched until
    // the result's pending proposals commit through the pipeline.
    expect(
      await store.getPluginData(
        SESSION_ID,
        "builtin-plugin",
        "state",
        "progress",
      ),
    ).toBeNull();

    await processRuntimeResult(
      {
        pluginId: "builtin-plugin",
        runtimeId: "builtin-plugin/worker",
        turnId: "turn-1",
        status: result.status,
        output: result.output,
        pendingProposals: result.pendingProposals,
      },
      store,
      SESSION_ID,
      "plugin",
    );

    const row = await store.getPluginData(
      SESSION_ID,
      "builtin-plugin",
      "state",
      "progress",
    );
    expect(row?.value).toEqual({ step: 1 });
  });
});
