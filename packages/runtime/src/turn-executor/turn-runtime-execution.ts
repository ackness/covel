import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import type { TurnMessageRecord } from "@covel/store";
import type {
  CoreMemoryBlockView,
  SessionContextSnapshot,
} from "@covel/context";
import type { HookPipeline } from "../hooks/pipeline.js";
import { makeFailedResult } from "./turn-executor-helpers.js";
import { runPostRuntimeHook } from "../hooks/wire-helpers.js";
import { emitSubEvent } from "./turn-runtime-helpers.js";
import { isRequiredUpstreamSatisfied } from "./turn-output-helpers.js";
import {
  MaxRecursionExceeded,
  type RecursiveTurnInput,
  type TurnExecutorDeps,
  type TurnExecutorOptions,
} from "./turn-executor-types.js";
import { executeAgentRuntime } from "../agent-loop/turn-agent-runtime.js";
import { executeFunctionRuntime } from "../function-runtime/turn-function-runtime.js";
import { executeAgentGuard } from "../agent-loop/turn-agent-guard.js";

export type ExecuteTurnFn = (
  input: TurnInput,
  activeRuntimes: readonly RuntimeManifest[],
  deps: TurnExecutorDeps,
  options?: TurnExecutorOptions,
) => Promise<TurnResult>;

/**
 * Everything needed to invoke a single runtime. Replaces what used to be a
 * 19-positional-argument call into `executeOneRuntime`: callers now build one
 * options object, and extending the invoker is a single-field change instead
 * of touching every call site. This is the `RuntimeInvoker` seam — the one
 * entry point that dispatches function vs agent runtimes. Resume
 * (`resumeSuspendedRuntime`) stays a distinct entry point because it is driven
 * by the resume API outside the scheduler, but it now shares the same tool loop
 * (`runAgentToolLoop`) and output finalization (`finalizeAgentOutput`) as the
 * normal agent path — the duplicated loop/finalize clone was removed in F1.b.
 */
export interface RuntimeInvocation {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  readonly deps: TurnExecutorDeps;
  readonly maxSteps: number;
  readonly defaultTimeoutMs: number;
  readonly messageHistory: readonly TurnMessageRecord[];
  readonly sessionMeta:
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
    | undefined;
  readonly hookPipeline: HookPipeline | undefined;
  readonly sessionSummaries:
    | readonly import("@covel/store").SessionSummaryRecord[]
    | undefined;
  readonly workingMemory:
    | readonly import("@covel/context").WorkingMemoryEntry[]
    | undefined;
  readonly coreMemoryBlocks: readonly CoreMemoryBlockView[] | undefined;
  readonly sessionContext: SessionContextSnapshot | undefined;
  readonly triggerEvent:
    | {
        readonly topic: string;
        readonly data: Readonly<Record<string, unknown>>;
      }
    | undefined;
  readonly turnOptions: TurnExecutorOptions | undefined;
  readonly executeTurnFn: ExecuteTurnFn;
  /** Internal current recursion depth. Top-level callers omit it (defaults 0). */
  readonly recursionDepth?: number;
}

export async function executeOneRuntime(
  inv: RuntimeInvocation,
): Promise<RuntimeResult> {
  const {
    manifest,
    input,
    activeRuntimes,
    completedResults,
    deps,
    maxSteps,
    defaultTimeoutMs,
    messageHistory,
    sessionMeta,
    hookPipeline,
    sessionSummaries,
    workingMemory,
    coreMemoryBlocks,
    sessionContext,
    triggerEvent,
    turnOptions,
    executeTurnFn,
    recursionDepth = 0,
  } = inv;
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
      // Two upstream-entry shapes (see UpstreamRequirement):
      //  • string        — that exact runtime must have produced a successful
      //                     result. An absent (disabled) upstream stays a skip,
      //                     never treated as success.
      //  • {capability}   — at least one in-scope runtime providing that
      //                     capability must have succeeded. Lets a guidance
      //                     plugin depend on "the active narrative engine"
      //                     without naming narrator / chat-mode-narrator; the
      //                     gate resolves whichever engine the current mode
      //                     loaded. Zero in-scope providers ⇒ unsatisfied (a
      //                     guidance runtime with no narrative engine to act on
      //                     should skip, not run blind).
      const missing: string[] = [];
      for (const entry of required) {
        if (typeof entry === "string") {
          const up = completedResults.get(entry);
          if (!up && sessionMeta?.preGameCompleted?.includes(entry)) continue;
          if (!isRequiredUpstreamSatisfied(up)) missing.push(entry);
          continue;
        }
        const providers = activeRuntimes
          .filter((r) => r.capabilities?.includes(entry.capability))
          .map((r) => r.name);
        const satisfied = providers.some((name) =>
          isRequiredUpstreamSatisfied(completedResults.get(name)),
        );
        if (!satisfied) missing.push(`capability:${entry.capability}`);
      }
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
