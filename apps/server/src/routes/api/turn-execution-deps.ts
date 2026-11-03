import type { EventBus } from "@covel/events";
import { estimateTokens } from "@covel/context";
import {
  createTraceRecorder,
  type ExecutionDeps,
  type TurnExecutorDeps,
} from "@covel/runtime";
import type { Context } from "hono";
import { pluginDatasetsLoader } from "./bootstrap/runtime-loader.js";

/**
 * Dependencies shared by player, manual, detached and resumed execution.
 *
 * Keep this composition in one place so action, plugin invocation, and job
 * routes cannot silently drift when a new runtime service is introduced.
 * Request-specific observability and commit ownership stay with the caller.
 */
export function buildTurnExecutorDeps(
  c: Context,
): Omit<TurnExecutorDeps, "store" | "eventBus" | "emitter"> {
  const gateway = c.get("pluginGateway");
  const utils = c.get("pluginUtils");
  const mediaStore = c.get("mediaStore");
  const contextBudget = c.get("turnContextBudget");
  const eventDirectory = c.get("eventDirectory");
  const hookPipeline = c.get("hookPipeline");
  const executionSignal = c.get("requestWork")?.signal;

  return {
    ...(c.get("pluginFaults") ? { pluginFaults: c.get("pluginFaults") } : {}),
    ...(executionSignal ? { turnControl: { executionSignal } } : {}),
    loadRuntime: c.get("loadRuntimeFn"),
    loadPluginDatasets: pluginDatasetsLoader(c.get("pluginRegistry")),
    llm: c.get("llmAdapter"),
    ...(hookPipeline ? { hookPipeline } : {}),
    ...(gateway ? { gateway } : {}),
    ...(c.get("pluginServices") ? { services: c.get("pluginServices") } : {}),
    ...(c.get("pluginExtensions")
      ? { extensions: c.get("pluginExtensions") }
      : {}),
    ...(utils ? { utils } : {}),
    ...(mediaStore ? { mediaStore } : {}),
    toolExecutor: c.get("toolExecutor"),
    resolveModel: c.get("resolveModel"),
    compactor: c.get("compactorRunner"),
    ...(contextBudget ? { estimator: estimateTokens, contextBudget } : {}),
    ...(eventDirectory ? { eventDirectory } : {}),
  };
}

/** Exact dependency policy for a resumed runtime. */
export function buildResumeTurnExecutorDeps(
  c: Context,
  emitter: NonNullable<TurnExecutorDeps["emitter"]>,
  eventBus: EventBus | undefined,
): ExecutionDeps {
  const trace = createTraceRecorder(
    c.get("store"),
    emitter.sessionId,
    emitter.turnId,
    emitter.traceId,
  );
  return {
    ...buildTurnExecutorDeps(c),
    onRuntimeStart: (info) => trace.runtimeStarted(info),
    onRuntimeComplete: (info) =>
      info.status === "failed"
        ? trace.runtimeFailed({
            ...info,
            error: info.error ?? "Runtime failed",
          })
        : trace.runtimeCompleted(info),
    store: c.get("store"),
    ...(eventBus ? { eventBus } : {}),
    emitter,
  };
}
