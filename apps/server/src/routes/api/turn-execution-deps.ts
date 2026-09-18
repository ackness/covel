import { estimateTokens } from "@covel/context";
import type { TurnExecutorDeps } from "@covel/runtime";
import type { Context } from "hono";
import {
  resolveTurnCapabilityPluginIds,
  type TurnCapabilityPluginIds,
} from "./turn-capabilities.js";

/**
 * Dependencies shared by manual runtime execution and detached followers.
 *
 * Keep this composition in one place so action, plugin invocation, and job
 * routes cannot silently drift when a new runtime service is introduced.
 * Request-specific observability and commit ownership stay with the caller.
 */
export function buildManualTurnExecutorDeps(
  c: Context,
  capabilityPluginIds: TurnCapabilityPluginIds,
): Omit<TurnExecutorDeps, "store" | "eventBus" | "emitter"> {
  const gateway = c.get("pluginGateway");
  const utils = c.get("pluginUtils");
  const getPluginSource = c.get("getPluginSource");
  const mediaStore = c.get("mediaStore");
  const contextBudget = c.get("turnContextBudget");
  const eventDirectory = c.get("eventDirectory");
  const hookPipeline = c.get("hookPipeline");
  const memorySystem = c.get("memorySystem");

  return {
    loadRuntime: c.get("loadRuntimeFn"),
    llm: c.get("llmAdapter"),
    ...(hookPipeline ? { hookPipeline } : {}),
    ...(gateway ? { gateway } : {}),
    ...(utils ? { utils } : {}),
    ...(getPluginSource ? { getPluginSource } : {}),
    ...(mediaStore ? { mediaStore } : {}),
    toolExecutor: c.get("toolExecutor"),
    resolveModel: c.get("resolveModel"),
    compactor: c.get("compactorRunner"),
    ...(contextBudget ? { estimator: estimateTokens, contextBudget } : {}),
    capabilityPluginIds,
    ...(eventDirectory ? { eventDirectory } : {}),
    ...(memorySystem ? { memorySystem } : {}),
  };
}

/** Exact dependency policy for a resumed runtime. */
export function buildResumeTurnExecutorDeps(
  c: Context,
  emitter: NonNullable<TurnExecutorDeps["emitter"]>,
): TurnExecutorDeps {
  const gateway = c.get("pluginGateway");
  const utils = c.get("pluginUtils");
  const hookPipeline = c.get("hookPipeline");
  const eventBus = c.get("eventBus");
  const contextBudget = c.get("turnContextBudget");

  return {
    loadRuntime: c.get("loadRuntimeFn"),
    llm: c.get("llmAdapter"),
    ...(gateway ? { gateway } : {}),
    ...(utils ? { utils } : {}),
    store: c.get("store"),
    toolExecutor: c.get("toolExecutor"),
    resolveModel: c.get("resolveModel"),
    ...(contextBudget ? { estimator: estimateTokens, contextBudget } : {}),
    ...(hookPipeline ? { hookPipeline } : {}),
    ...(eventBus ? { eventBus } : {}),
    capabilityPluginIds: resolveTurnCapabilityPluginIds(
      c.get("pluginRegistry"),
      emitter.sessionId,
    ),
    ...(c.get("memorySystem") ? { memorySystem: c.get("memorySystem") } : {}),
    emitter,
  };
}
