import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import type { TurnMessageRecord } from "@covel/store";
import type { SessionContextSnapshot } from "@covel/context";
import type { HookPipeline } from "./hooks/pipeline.js";
import { makeFailedResult } from "./turn-executor-helpers.js";
import { runPostRuntimeHook } from "./hooks/wire-helpers.js";
import { emitSubEvent } from "./turn-runtime-helpers.js";
import { isRequiredUpstreamSatisfied } from "./turn-output-helpers.js";
import {
  MaxRecursionExceeded,
  type RecursiveTurnInput,
  type TurnExecutorDeps,
  type TurnExecutorOptions,
} from "./turn-executor-types.js";
import { executeAgentRuntime } from "./turn-agent-runtime.js";
import { executeFunctionRuntime } from "./turn-function-runtime.js";
import { executeAgentGuard } from "./turn-agent-guard.js";

export type ExecuteTurnFn = (
  input: TurnInput,
  activeRuntimes: readonly RuntimeManifest[],
  deps: TurnExecutorDeps,
  options?: TurnExecutorOptions,
) => Promise<TurnResult>;

export async function executeOneRuntime(
  manifest: RuntimeManifest,
  input: TurnInput,
  activeRuntimes: readonly RuntimeManifest[],
  completedResults: ReadonlyMap<string, RuntimeResult>,
  deps: TurnExecutorDeps,
  maxSteps: number,
  defaultTimeoutMs: number,
  messageHistory: readonly TurnMessageRecord[],
  sessionMeta:
    | {
        turnNumber: number;
        characters: readonly {
          name: string;
          type: string;
          description?: string;
          fields?: Record<string, unknown>;
        }[];
        lastFormValues?: Record<string, unknown>;
        preGameCompleted?: readonly string[];
      }
    | undefined,
  hookPipeline: HookPipeline | undefined,
  sessionSummaries:
    | readonly import("@covel/store").SessionSummaryRecord[]
    | undefined,
  workingMemory:
    | readonly import("@covel/context").WorkingMemoryEntry[]
    | undefined,
  coreMemoryBlocks:
    | readonly {
        label: string;
        content: string;
        updatedAt: string;
      }[]
    | undefined,
  sessionContext: SessionContextSnapshot | undefined,
  triggerEvent:
    | {
        readonly topic: string;
        readonly data: Readonly<Record<string, unknown>>;
      }
    | undefined,
  turnOptions: TurnExecutorOptions | undefined,
  executeTurnFn: ExecuteTurnFn,
  recursionDepth = 0,
): Promise<RuntimeResult> {
  const startTime = Date.now();
  const runId = crypto.randomUUID();
  const timeoutMs = manifest.timeoutMs ?? defaultTimeoutMs;
  const createRecursiveCall = () => {
    return async (
      delta: Partial<TurnInput>,
      opts?: { readonly reason?: string },
    ): Promise<TurnResult> => {
      const maxDepth =
        manifest.maxRecursionDepth ?? turnOptions?.maxRecursionDepth ?? 10;
      const nextDepth = recursionDepth + 1;
      const reason =
        typeof opts?.reason === "string" && opts.reason.length > 0
          ? opts.reason
          : undefined;

      const nestedInput: RecursiveTurnInput = {
        ...input,
        ...delta,
        sessionId: delta.sessionId ?? input.sessionId,
        turnId: delta.turnId ?? input.turnId,
        playerMessage: delta.playerMessage ?? input.playerMessage,
        suppressPlayerMessage: true,
      };

      const tracePayload = {
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        depth: recursionDepth,
        nextDepth,
        maxDepth,
        turnId: nestedInput.turnId,
        sessionId: nestedInput.sessionId,
        ...(reason ? { reason } : {}),
      };

      if (nextDepth > maxDepth) {
        const err = new MaxRecursionExceeded({
          runtimeId: manifest.name,
          depth: nextDepth,
          maxDepth,
        });
        await deps.emitter?.emit("recursive.failed", {
          ...tracePayload,
          error: err.message,
        });
        throw err;
      }

      await deps.emitter?.emit("recursive.calling", tracePayload);
      try {
        const nestedResult = await executeTurnFn(
          nestedInput,
          activeRuntimes,
          deps,
          {
            ...turnOptions,
            maxSteps,
            timeoutMs: defaultTimeoutMs,
            recursionDepth: nextDepth,
          },
        );
        await deps.emitter?.emit("recursive.completed", {
          ...tracePayload,
          resultCount: nestedResult.runtimeResults.length,
          durationMs: nestedResult.durationMs,
        });
        return nestedResult;
      } catch (err) {
        await deps.emitter?.emit("recursive.failed", {
          ...tracePayload,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
  };

  try {
    // ── Upstream gate (manifest.upstreamRequired) ─────────────────
    // Must run before loadRuntime so a failing upstream short-circuits
    // the whole pipeline: no prompt template read, no guard, no LLM call,
    // no runtime.started event. Emits a single runtime.completed{skipped}
    // so the frontend shows the runtime as skipped rather than hanging.
    const required = manifest.upstreamRequired ?? [];
    if (required.length > 0) {
      const missing = required.filter((id) => {
        const up = completedResults.get(id);
        if (!up && sessionMeta?.preGameCompleted?.includes(id)) return false;
        return !isRequiredUpstreamSatisfied(up);
      });
      if (missing.length > 0) {
        const reason = `upstream not success: ${missing.join(", ")}`;
        const skipResult: RuntimeResult = {
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          runId,
          turnId: input.turnId,
          status: "skipped",
          output: {
            skipped: true,
            reason,
            skippedBy: "framework:upstreamRequired",
            missingUpstreams: missing,
          },
          toolCalls: [],
          durationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
        try {
          await deps.onRuntimeComplete?.({
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
            status: "skipped",
            durationMs: skipResult.durationMs,
          });
        } catch {
          /* callback error must not kill runtime */
        }
        emitSubEvent(
          deps.eventBus,
          "runtime",
          "runtime.completed",
          input.sessionId,
          {
            runtimeId: manifest.name,
            pluginId: manifest.pluginId,
            status: "skipped",
            durationMs: skipResult.durationMs,
            reason,
          },
        );
        return skipResult;
      }
    }

    // Load the runtime (prompt template, references, handler, etc.)
    const loaded = await deps.loadRuntime(manifest, input.locale);
    if (!loaded) {
      return makeFailedResult(
        manifest,
        input,
        runId,
        startTime,
        "Runtime not found",
      );
    }

    if (manifest.runtimeType === "function") {
      return await executeFunctionRuntime({
        manifest,
        input,
        loaded,
        completedResults,
        deps,
        hookPipeline,
        triggerEvent,
        createRecursiveCall,
        recursionDepth,
        startTime,
        runId,
      });
    }

    const guardResult = await executeAgentGuard({
      manifest,
      input,
      loaded,
      completedResults,
      deps,
      hookPipeline,
      triggerEvent,
      createRecursiveCall,
      recursionDepth,
      startTime,
      runId,
    });
    if (guardResult) return guardResult;

    return await executeAgentRuntime({
      manifest,
      input,
      loaded,
      completedResults,
      deps,
      maxSteps,
      timeoutMs,
      messageHistory,
      sessionMeta,
      hookPipeline,
      sessionSummaries,
      workingMemory,
      coreMemoryBlocks,
      sessionContext,
      startTime,
      runId,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const failedResult = makeFailedResult(
      manifest,
      input,
      runId,
      startTime,
      message,
    );
    await deps.onRuntimeComplete?.({
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: failedResult.status,
      durationMs: failedResult.durationMs,
      error: message,
    });

    emitSubEvent(deps.eventBus, "runtime", "runtime.failed", input.sessionId, {
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: failedResult.status,
      durationMs: failedResult.durationMs,
      error: message,
    });

    // PostRuntime hook — failure path (S4-T3)
    return runPostRuntimeHook(
      {
        pipeline: hookPipeline,
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        eventBus: deps.eventBus,
        emitter: deps.emitter,
      },
      failedResult,
    );
  }
}

// buildToolDefinitions and makeFailedResult extracted to turn-executor-helpers.ts (S4-T3)
