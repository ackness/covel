import type {
  ExecutionContext,
  NestedTurnResult,
  RecursiveCallDelta,
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
import { isSetupRuntime } from "@covel/shared";
import { validateOutput } from "@covel/tools";
import {
  deriveActivation,
  resolveInputBindings,
} from "../schedule/input-bindings.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import {
  makeFailedResult,
  makeSkippedResult,
} from "./turn-executor-helpers.js";
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
 * normal agent path — the duplicated loop/finalize clone was removed.
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
    readonly import("@covel/store").SessionSummaryRecord[] | undefined;
  readonly workingMemory:
    readonly import("@covel/context").WorkingMemoryEntry[] | undefined;
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
  /** Execution identity — forwarded to the function-runtime `ctx.progress` scope. */
  readonly executionId?: string;
  /**
   * Full execution identity for this scheduling run — exposed to function
   * handlers as `ctx.execution` and to the agent activation segment. Absent
   * for thin direct callers / tests.
   */
  readonly executionContext?: ExecutionContext;
  /**
   * Generation of this setup runtime's mirror, for the attempt-ledger `started`
   * insert. Present only for setup runtimes; absent means "not a setup run".
   */
  readonly setupGeneration?: number;
  /**
   * Implicit per-plugin session gate. A non-setup runtime is skipped
   * (`setup-incomplete`) when its plugin's setup runtimes are not all done.
   * Absent (direct callers / tests) means "no gate — always ready".
   */
  readonly pluginSetupReady?: (pluginId: string) => boolean;
  /**
   *  sink for runtime results produced by nested `ctx.recursiveCall`
   * executions. The top-level executeTurn wires this to a collector so the
   * commit-owning caller processes nested proposals through the same barrier
   * as top-level results (they were previously dropped on the floor).
   */
  readonly collectNestedResults?: (results: readonly RuntimeResult[]) => void;
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
    executionId,
    executionContext,
  } = inv;
  const startTime = Date.now();
  const runId = crypto.randomUUID();
  const timeoutMs = manifest.timeoutMs ?? defaultTimeoutMs;
  const createRecursiveCall = () => {
    return async (
      rawDelta: RecursiveCallDelta,
      opts?: { readonly reason?: string },
    ): Promise<NestedTurnResult> => {
      const maxDepth =
        manifest.maxRecursionDepth ?? turnOptions?.maxRecursionDepth ?? 10;
      const nextDepth = recursionDepth + 1;
      const reason =
        typeof opts?.reason === "string" && opts.reason.length > 0
          ? opts.reason
          : undefined;

      // Execution identity is framework-owned. The public delta type already
      // omits these, but plugin code is untyped JS at runtime — strip them so
      // a handler cannot hop sessions or forge a child turnId that the parent
      // turn can never settle.
      const {
        sessionId: _s,
        turnId: _t,
        origin: _o,
        parentTurnId: _p,
        ...delta
      } = rawDelta as Partial<TurnInput>;

      const nestedInput: RecursiveTurnInput = {
        ...input,
        ...delta,
        sessionId: input.sessionId,
        turnId: input.turnId,
        playerMessage: delta.playerMessage ?? input.playerMessage,
        suppressPlayerMessage: true,
        // A nested execution is never a player turn — stamp its origin
        // and parent so turn accounting excludes it from `turnCount`.
        origin: "recursive",
        parentTurnId: input.turnId,
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
        // Bubble the nested execution's results (its own + any it
        // collected from deeper levels) up to the top-level turn so the
        // commit-owning caller processes their proposals — a nested
        // executeTurn has no commit path of its own.
        inv.collectNestedResults?.([
          ...nestedResult.runtimeResults,
          ...(nestedResult.nestedRuntimeResults ?? []),
        ]);
        await deps.emitter?.emit("recursive.completed", {
          ...tracePayload,
          resultCount: nestedResult.runtimeResults.length,
          durationMs: nestedResult.durationMs,
        });
        // Hand back a de-capabilitised DTO: `completeTurn` would let plugin
        // code emit the authoritative `turn.completed` (and kick memory
        // ingestion) before the parent's proposals ever commit.
        const { completeTurn: _drop, ...nestedView } = nestedResult;
        return nestedView;
      } catch (err) {
        await deps.emitter?.emit("recursive.failed", {
          ...tracePayload,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
  };

  // Emit a terminal `runtime.completed` for a pre-dispatch gate result
  // (input.schema failure, binding gate skip) — no `runtime.started` fired yet,
  // mirroring the upstream/session gates above.
  const emitGateTerminal = async (
    result: RuntimeResult,
    reason?: string,
  ): Promise<RuntimeResult> => {
    try {
      await deps.onRuntimeComplete?.({
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        status: result.status,
        durationMs: result.durationMs,
        ...(result.error ? { error: result.error } : {}),
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
        status: result.status,
        durationMs: result.durationMs,
        ...(reason ? { reason } : {}),
      },
    );
    return result;
  };

  try {
    // ── Implicit per-plugin session gate ──────────────────────────
    // A non-setup runtime is skipped while any of its OWN plugin's active setup
    // runtimes is not yet done (incl. waived). This holds for the manual RPC
    // path too: manual bypasses the turn cadence gate but not the session gate.
    // Setup runtimes are exempt (they ARE the setup being gated on).
    if (!isSetupRuntime(manifest) && inv.pluginSetupReady) {
      if (!inv.pluginSetupReady(manifest.pluginId)) {
        const skipResult = makeSkippedResult(
          manifest,
          input,
          "setup-incomplete",
          "framework:setupGate",
        );
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
            reason: "setup-incomplete",
          },
        );
        return skipResult;
      }
    }

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

    // ── Setup attempt ledger: `started` ───────────────────────────
    // Recorded once the gates pass and BEFORE the guard/handler runs, so a
    // crash mid-execution leaves a `started` row (a spent-but-unresolved
    // signature). Dependency skips above return earlier and spend no attempt.
    // Idempotent on (session, runtime, generation, executionId); the finalize
    // settle terminalises it.
    if (
      isSetupRuntime(manifest) &&
      deps.store &&
      inv.setupGeneration !== undefined &&
      executionId !== undefined
    ) {
      try {
        await deps.store.insertSetupAttempt({
          sessionId: input.sessionId,
          runtimeId: manifest.name,
          pluginVersion: manifest.version ?? "0.0.0",
          generation: inv.setupGeneration,
          executionId,
          state: "started",
          startedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(
          `[turn-executor] setup attempt 'started' insert failed for ${manifest.name}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Load the runtime (prompt template, references, handler, etc.)
    const loaded = await deps.loadRuntime(
      manifest,
      input.locale,
      input.sessionId,
    );
    if (!loaded) {
      return makeFailedResult(
        manifest,
        input,
        runId,
        startTime,
        "Runtime not found",
      );
    }

    // ── Activation, input.schema enforce, input bindings ──────────
    // Derive this activation (stage / event / manual), enforce the activation
    // payload against `input.schema`, then resolve `inputs` bindings into
    // provenance slots (or a gate skip). Manual activations project turn
    // bindings away; detached activations that still carry them are rejected.
    const activation = deriveActivation(manifest, input, triggerEvent);

    if (loaded.inputSchema) {
      const validation = validateOutput(activation.payload, loaded.inputSchema);
      if (!validation.valid) {
        const error = `activation payload failed input.schema: ${(
          validation.errors ?? ["unknown schema validation error"]
        )
          .slice(0, 3)
          .join("; ")}`;
        return emitGateTerminal(
          makeFailedResult(manifest, input, runId, startTime, error),
          "input-schema-invalid",
        );
      }
    }

    const binding = await resolveInputBindings({
      manifest,
      activation,
      activeRuntimes,
      completedResults,
      acceptsSchemas: loaded.bindingAcceptsSchemas ?? {},
      // ponytail: re-loads the producer only for its declared output.schema, and
      // only when the consumer declares `accepts`. ES import is cached, so this
      // is a cheap re-parse; add a per-turn schema cache if it ever shows up.
      loadProducerSchema: async (producer) =>
        (await deps.loadRuntime(producer, input.locale, input.sessionId))
          ?.outputSchema,
    });
    for (const d of binding.diagnostics) {
      if (d.severity === "error") {
        console.warn(
          `[turn-executor] ${manifest.name}: ${d.code} — ${d.message}`,
        );
      }
    }
    if (!binding.ok) {
      return emitGateTerminal(
        makeSkippedResult(
          manifest,
          input,
          binding.skipReason,
          "framework:inputBinding",
        ),
        binding.skipReason,
      );
    }
    const inputSlots = binding.slots;

    if (manifest.runtimeType === "function") {
      return await executeFunctionRuntime({
        manifest,
        input,
        loaded,
        completedResults,
        deps,
        hookPipeline,
        triggerEvent,
        activation,
        inputs: inputSlots,
        ...(executionContext ? { executionContext } : {}),
        createRecursiveCall,
        recursionDepth,
        startTime,
        runId,
        timeoutMs,
        executionId,
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
      timeoutMs,
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
      activation,
      inputs: inputSlots,
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

    // PostRuntime hook — failure path
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

// buildToolDefinitions and makeFailedResult extracted to turn-executor-helpers.ts
