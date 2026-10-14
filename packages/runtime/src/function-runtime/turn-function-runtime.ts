import { toJsonValueOrDiagnostic } from "@covel/shared";
import { reportRuntimeStarted } from "../trace/runtime-telemetry.js";
import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  NestedTurnResult,
  RecursiveCallDelta,
  RuntimeActivation,
  ExecutionContext,
  InputSlot,
} from "@covel/shared";
import { attachRuntimeJournal } from "../execution-journal.js";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import type { SuspensionRecord } from "@covel/store";
import { validateOutput, getToolContent } from "@covel/tools";
import { createExecutionWriteBuffer } from "./execution-write-buffer.js";
import { normalizeHandlerResult } from "../commit/normalize-handler-result.js";
import { materializeHandlerSuccess } from "../commit/materialize-handler-output.js";
import { collectUiBlocks } from "../session/session-kernel-helpers.js";
import { finalizeRuntimeResult } from "../turn-executor/runtime-finalization.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import { makeFailedResult } from "../turn-executor/turn-executor-helpers.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { RuntimeTimeoutError } from "../turn-executor/turn-control.js";
import { attachSuspensionArtifact } from "../suspension-artifact.js";
import { suspensionBasis } from "../resume/suspension-settlement.js";
import { freezeInputSlots } from "../agent-loop/runtime-input-slots.js";
import { deepFreeze } from "../hooks/hook-settings.js";
import { createPluginRuntimeContext } from "./plugin-runtime-context.js";

export interface ExecuteFunctionRuntimeOptions {
  readonly lastPlayerInput?:
    import("@covel/shared").PlayerInputSubmission | null;
  /** The scheduler's logical turn for this execution. */
  readonly logicalTurn?: number;
  readonly upstreamProposals?: readonly import("@covel/shared").Proposal[];
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly loaded: LoadedRuntime;
  readonly deps: TurnExecutorDeps;
  readonly hookPipeline: HookPipeline | undefined;
  readonly triggerEvent:
    | {
        readonly topic: string;
        readonly data: Readonly<Record<string, unknown>>;
      }
    | undefined;
  /** Canonical activation for this run — exposed as `ctx.activation`. */
  readonly activation?: RuntimeActivation;
  /** Resolved provenance-wrapped input bindings — exposed as `ctx.inputs`. */
  readonly inputs?: Readonly<Record<string, InputSlot>>;
  /** Frozen cross-execution `recordAs` exports — exposed as `ctx.exports`. */
  readonly exports?: Readonly<Record<string, InputSlot>>;
  /** Full execution identity — exposed as `ctx.execution`. */
  readonly executionContext: ExecutionContext;
  readonly createRecursiveCall: (
    parentSignal?: AbortSignal,
  ) => (
    delta: RecursiveCallDelta,
    opts?: { readonly reason?: string },
  ) => Promise<NestedTurnResult>;
  readonly recursionDepth: number;
  readonly startTime: number;
  readonly runId: string;
  /**
   * Total-duration hard cap for the handler (`manifest.timeoutMs` ??
   * executor default) — the same contract the agent path enforces. Function
   * runtimes have no retry loop, so this is a plain deadline.
   */
  readonly timeoutMs: number;
  /**
   * Execution identity of this scheduling run — the default `progressScopeId`
   * for `ctx.progress`. Absent for entry points that don't thread an
   * `ExecutionContext` (thin test harnesses); the reporter falls back to the
   * turnId scope in that case.
   */
  readonly executionId?: string;
  /** Resume payload for a previously suspended function runtime. */
  readonly resumeData?: unknown;
  /** Identifies a resume invocation even when `resumeData` is undefined. */
  readonly resumedFromSuspensionId?: string;
  /** Uncommitted writes captured by the suspended invocation. */
  readonly pendingProposals?: readonly import("@covel/shared").Proposal[];
  /** Resume forbids creating a second nested suspension. Defaults to true. */
  readonly allowSuspend?: boolean;
}

export async function executeFunctionRuntime({
  lastPlayerInput = null,
  logicalTurn,
  upstreamProposals = [],
  manifest,
  input,
  loaded,
  deps,
  hookPipeline,
  triggerEvent,
  activation: originalActivation,
  inputs: originalInputs,
  exports: originalExports,
  executionContext,
  createRecursiveCall,
  recursionDepth,
  startTime,
  runId,
  timeoutMs,
  executionId,
  resumeData,
  resumedFromSuspensionId,
  pendingProposals = [],
  allowSuspend = true,
}: ExecuteFunctionRuntimeOptions): Promise<RuntimeResult> {
  const inputs = originalInputs ? freezeInputSlots(originalInputs) : undefined;
  const exportSlots = originalExports
    ? freezeInputSlots(originalExports)
    : undefined;
  const activation = originalActivation
    ? deepFreeze(structuredClone(originalActivation))
    : undefined;
  // Emit start for function runtimes (no guard to check)
  await reportRuntimeStarted(deps, input.sessionId, manifest, {
    turnId: input.turnId,
    runId,
  });

  const helperCtx = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  };

  // Execution write buffer: ctx.pluginData / ctx.store domain writes route
  // through this instead of hitting the store directly, and flush onto the
  // result pendingProposals at execution end so they commit in finalizeExecution's
  // single transaction (and roll back with it if the handler fails).
  const writeBuffer = createExecutionWriteBuffer();
  writeBuffer.push(...structuredClone(pendingProposals));

  if (!loaded.handler) {
    return finalizeRuntimeResult(
      { ...deps, hookPipeline },
      manifest,
      input,
      makeFailedResult(
        manifest,
        input,
        runId,
        startTime,
        "Function runtime missing handler",
      ),
    );
  }
  const runtimeContext = await createPluginRuntimeContext({
    manifest,
    input,
    loaded,
    deps,
    hookPipeline,
    triggerEvent,
    lastPlayerInput,
    ...(logicalTurn !== undefined ? { logicalTurn } : {}),
    upstreamProposals,
    ...(activation ? { activation } : {}),
    ...(inputs ? { inputs } : {}),
    ...(exportSlots ? { exports: exportSlots } : {}),
    executionContext,
    ...(resumedFromSuspensionId !== undefined
      ? { resumeData, resumedFromSuspensionId }
      : {}),
    createRecursiveCall,
    recursionDepth,
    startTime,
    timeoutMs,
    ...(executionId !== undefined ? { executionId } : {}),
    writeBuffer,
  });
  const handlerAbort = runtimeContext.abort;
  const runtimeTools = runtimeContext.tools;

  await deps.emitter?.emit("function.executing", {
    ...helperCtx,
    recursionDepth,
    hasGateway: !!deps.gateway,
  });

  let output: Awaited<ReturnType<NonNullable<typeof loaded.handler>>>;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    // Deadline race: without it a hung handler (e.g. a provider call that
    // never resolves) blocks the whole turn forever — timeoutMs only existed
    // for the agent path before. Promise.race subscribes to the handler
    // promise, so a post-timeout rejection is still observed (no unhandled
    // rejection). The merged abort signal (ctx.signal) lets a cooperative
    // handler cancel its own in-flight provider work; a NON-cooperative
    // losing handler keeps running detached, but its capabilities are
    // revoked in the finally below so late writes are rejected.
    const handlerPromise = loaded.handler(runtimeContext.context);
    const handlerWork = handlerPromise.then(async (result) => {
      // A handler may intentionally launch a recursive call without awaiting
      // it. Keep the invocation lease until all nested turns have settled.
      await runtimeContext.drain();
      return result;
    });
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => {
        // Revoke synchronously with the abort so no capability call can enter
        // during the Promise.race rejection microtask window.
        runtimeContext.revoke();
        const reason = handlerAbort.signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : new Error(`function runtime "${manifest.name}" was aborted`),
        );
      };
      if (handlerAbort.signal.aborted) {
        onAbort();
        return;
      }
      handlerAbort.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () =>
        handlerAbort.signal.removeEventListener("abort", onAbort);
    });
    output = await Promise.race([
      handlerWork,
      aborted,
      new Promise<never>(() => {
        deadlineTimer = setTimeout(() => {
          const err = new RuntimeTimeoutError(
            `function runtime "${manifest.name}" timed out after ${timeoutMs}ms`,
          );
          handlerAbort.abort(err);
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    // Function-layer terminal marker; rethrow so the dispatch catch emits the
    // single runtime.failed (avoids a double terminal event).
    await deps.emitter?.emit("function.completed", {
      ...helperCtx,
      status: "failed",
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    clearTimeout(deadlineTimer);
    removeAbortListener?.();
    runtimeContext.dispose();
    // The race has settled — no further capability use is legitimate,
    // whether the handler won (its output is final) or lost (it is detached).
    runtimeContext.revoke();
    if (!handlerAbort.signal.aborted) {
      handlerAbort.abort(
        new Error(`function runtime "${manifest.name}" completed`),
      );
    }
    // Invocation work already propagates tool failures. Cleanup must settle
    // outstanding calls without replacing the original timeout or error.
    await runtimeContext.drain().catch(() => undefined);
  }

  const { outcome: handlerOutcome, diagnostics } = normalizeHandlerResult(
    getToolContent(output),
  );
  for (const diagnostic of diagnostics) {
    console.warn(
      `[runtime] ${manifest.name}: ${diagnostic.code} — ${diagnostic.message}`,
    );
  }

  await deps.emitter?.emit("function.completed", {
    ...helperCtx,
    status:
      handlerOutcome.outcome === "success" ? "success" : handlerOutcome.outcome,
    durationMs: Date.now() - startTime,
  });

  // ── Suspend detection for function runtimes ────────────
  // A resume invocation must not create a second suspension record.
  if (handlerOutcome.outcome === "suspended" && allowSuspend) {
    const suspensionId = crypto.randomUUID();
    // Keep domain writes uncommitted until resume succeeds. The continuation
    // also owns the original binding snapshots rather than resolving them again.
    const suspension: SuspensionRecord = {
      id: suspensionId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      reason: handlerOutcome.reason,
      resumeSchema: handlerOutcome.resumeSchema ?? {},
      pendingContinuation: {
        messages: [],
        toolCallsSoFar: [],
        pendingProposals: structuredClone(writeBuffer),
        ...(inputs ? { inputSlots: structuredClone(inputs) } : {}),
        ...(exportSlots ? { exportSlots: structuredClone(exportSlots) } : {}),
        ...(activation ? { activation: structuredClone(activation) } : {}),
        emittedEvents: [],
        executionContext,
        // `executeTurn` sets the player turns once it knows the whole execution.
        takenUnder: suspensionBasis(manifest, 0),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(logicalTurn !== undefined ? { logicalTurn } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const suspendedResult: RuntimeResult = {
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: input.turnId,
      status: "suspended",
      output: {
        suspended: true,
        suspensionId,
        reason: suspension.reason,
        resumeSchema: suspension.resumeSchema,
      },
      toolCalls: [],
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };

    const finalResult = await finalizeRuntimeResult(
      { ...deps, hookPipeline },
      manifest,
      input,
      suspendedResult,
    );
    return finalResult.status === "suspended"
      ? attachSuspensionArtifact(finalResult, { record: suspension })
      : finalResult;
  }

  // `output.schema` validates the canonical success value. A mismatch fails
  // the runtime and commits no domain effects.
  let envelopeSchemaError: string | undefined;
  if (loaded.outputSchema && handlerOutcome.outcome === "success") {
    const validation = validateOutput(
      handlerOutcome.value,
      loaded.outputSchema,
    );
    if (!validation.valid) {
      const errors = validation.errors ?? ["unknown schema validation error"];
      const detail = errors.slice(0, 5).join("; ");
      envelopeSchemaError = `output-schema-invalid: ${detail}`;
    }
  }

  const materialized: Pick<RuntimeResult, "output" | "effects" | "completion"> =
    !envelopeSchemaError && handlerOutcome.outcome === "success"
      ? materializeHandlerSuccess(handlerOutcome, output)
      : {
          output: getToolContent(output) as unknown as Record<string, unknown>,
          ...(!envelopeSchemaError &&
          (handlerOutcome.outcome === "failed" ||
            handlerOutcome.outcome === "skipped") &&
          handlerOutcome.effects
            ? { effects: structuredClone(handlerOutcome.effects) }
            : {}),
        };

  let effects = materialized.effects;

  if (
    !envelopeSchemaError &&
    handlerOutcome.outcome === "success" &&
    runtimeTools.events.length > 0
  ) {
    effects = {
      ...effects,
      events: [
        ...(Array.isArray(effects?.events) ? effects.events : []),
        ...runtimeTools.events.map((event) =>
          toJsonValueOrDiagnostic(event, "event"),
        ),
      ],
    };
  }
  if (!envelopeSchemaError && handlerOutcome.outcome === "success") {
    const ui = collectUiBlocks({ ui: effects?.ui }, runtimeTools.records);
    if (ui.length > 0)
      effects = { ...effects, ui: ui as import("@covel/shared").JsonValue[] };
  }

  // A failed schema gate overrides the handler outcome: the runtime
  // fails with `output-schema-invalid` and no domain effects are committed.
  const rawResult: RuntimeResult = {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: envelopeSchemaError
      ? "failed"
      : handlerOutcome.outcome === "success"
        ? "success"
        : handlerOutcome.outcome,
    ...materialized,
    ...(effects ? { effects } : {}),
    ...(handlerOutcome.outcome === "success"
      ? {
          canonicalValue:
            handlerOutcome.value === undefined
              ? {}
              : { value: structuredClone(handlerOutcome.value) },
        }
      : {}),
    toolCalls: runtimeTools.records,
    durationMs: Date.now() - startTime,
    ...(envelopeSchemaError
      ? { error: envelopeSchemaError }
      : handlerOutcome.outcome === "failed"
        ? { error: handlerOutcome.error }
        : {}),
    timestamp: new Date().toISOString(),
  };

  const result = await finalizeRuntimeResult(
    { ...deps, hookPipeline },
    manifest,
    input,
    rawResult,
    {
      outputContractSchema: loaded.outputContractSchema,
      outputSchema: loaded.outputSchema,
    },
  );

  // Keep commands separate from business output; copying the result preserves them.
  // The buffer belongs to the handler's own success: a failed handler that a
  // PostRuntime hook turned into success commits none of its buffered writes.
  const completedResult: RuntimeResult =
    rawResult.status === "success" &&
    result.status === "success" &&
    writeBuffer.length > 0
      ? {
          ...result,
          pendingProposals: [
            ...(result.pendingProposals ?? []),
            ...writeBuffer,
          ],
        }
      : result;

  const finalOutput = (completedResult.output ??
    getToolContent(output)) as Record<string, unknown>;

  if (deps.store)
    attachRuntimeJournal(completedResult, input, manifest, finalOutput);

  return completedResult;
}
