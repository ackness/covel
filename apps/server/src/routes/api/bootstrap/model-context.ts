/**
 * Bootstrap stage 6: model selection and the context budget shared by turns
 * and runtime jobs — the slot resolver, the startup compactor and the
 * prompt-assembly budget.
 */

import type { RuntimeManifest } from "@covel/shared";
import { readRuntimeEnv } from "@covel/shared";
import type { CompactorRunner } from "@covel/context";
import type { PluginExtensionHost, LLMAdapter } from "@covel/runtime";
import type { DataStore } from "@covel/store";
import { getRequestLlmOptions } from "../../../request-llm-context.js";
import {
  CompactionFailureTracker,
  createBootstrapCompactorRunner,
  createTurnContextBudget,
} from "./compactor.js";

/**
 * A runtime names only the role (slot) it wants; which model serves that
 * role, and where the request goes, is the player's configuration. An
 * explicit runtime/API selection wins; a runtime that names no role uses the
 * request's `default` binding when there is one, else the default slot.
 */
export function resolveRuntimeModel(
  manifest: RuntimeManifest,
  apiOverride?: string,
): string | undefined {
  return (
    apiOverride ??
    manifest.model ??
    (getRequestLlmOptions()?.slotOverrides?.slotBindings?.default !== undefined
      ? "default"
      : undefined)
  );
}

export interface BootstrapModelContext {
  /** Environment read at this stage; later stages reuse it. */
  readonly runtimeEnv: ReturnType<typeof readRuntimeEnv>;
  /** Deployment context-window ceiling, shared by request-scoped runners. */
  readonly budgetSource: { readonly contextWindowOverride?: number };
  readonly resolveModel: typeof resolveRuntimeModel;
  /** Shared by every request's runner so a run of failures counts across turns. */
  readonly compactionFailures: CompactionFailureTracker;
  readonly compactorRunner: CompactorRunner;
  readonly turnContextBudget: ReturnType<typeof createTurnContextBudget>;
}

export function createBootstrapModelContext(args: {
  readonly extensions: PluginExtensionHost;
  readonly store: DataStore;
  readonly llmAdapter: LLMAdapter;
}): BootstrapModelContext {
  const runtimeEnv = readRuntimeEnv();
  const budgetSource =
    runtimeEnv.compactorContextWindow !== undefined
      ? { contextWindowOverride: runtimeEnv.compactorContextWindow }
      : {};
  const compactionFailures = new CompactionFailureTracker();
  const compactorRunner = createBootstrapCompactorRunner({
    extensions: args.extensions,
    store: args.store,
    llmAdapter: args.llmAdapter,
    failures: compactionFailures,
    ...budgetSource,
  });
  const turnContextBudget = createTurnContextBudget(budgetSource);
  return {
    runtimeEnv,
    budgetSource,
    resolveModel: resolveRuntimeModel,
    compactionFailures,
    compactorRunner,
    turnContextBudget,
  };
}
