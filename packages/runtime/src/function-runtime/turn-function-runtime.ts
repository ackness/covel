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
import {
  finalizeRuntimeFailure,
  finalizeSuspension,
  runLeasedInvocation,
} from "../turn-executor/runtime-scaffold.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { suspensionBasis } from "../resume/suspension-settlement.js";
import { freezeInputSlots } from "../agent-loop/runtime-input-slots.js";
import { deepFreeze } from "../hooks/hook-settings.js";
import { createPluginRuntimeContext } from "./plugin-runtime-context.js";
import { attachNestedResults } from "../turn-executor/nested-results.js";
import { suspendNestedResults } from "../resume/suspended-nested-results.js";
import { attachReadDependencies } from "../read-dependencies.js";
import {
  createPluginDataVisibility,
  type PluginDataVisibility,
  type UpstreamPluginDataWrite,
} from "./upstream-plugin-data.js";

export interface ExecuteFunctionRuntimeOptions {
  readonly lastPlayerInput?:
    import("@covel/shared").PlayerInputSubmission | null;
  /** The scheduler's logical turn for this execution. */
  readonly logicalTurn?: number;
  readonly upstreamProposals?: readonly import("@covel/shared").Proposal[];
  /** Writes of completed upstream runtimes of this plugin that reads include. */
  readonly upstreamPluginData?: readonly UpstreamPluginDataWrite[];
  readonly upstreamOf?: PluginDataVisibility["upstreamOf"];
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
  /**
   * `ctx.recursiveCall` results of the suspended invocation, in commit order.
   * Like its buffered writes, they commit only with the handler's own success,
   * and a further suspension carries them on.
   */
  readonly restoredNested?: readonly RuntimeResult[];
}

export async function executeFunctionRuntime({
  lastPlayerInput = null,
  logicalTurn,
  upstreamProposals = [],
  upstreamPluginData = [],
  upstreamOf,
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
  restoredNested = [],
}: ExecuteFunctionRuntimeOptions): Promise<RuntimeResult> {
  const inputs = originalInputs ? freezeInputSlots(originalInputs) : undefined;
  const exportSlots = originalExports
    ? freezeInputSlots(originalExports)
    : undefined;
  const activation = originalActivation
    ? deepFreeze(structuredClone(originalActivation))
    : undefined;
  // Emit start for function runtimes (no guard to check)
  await reportRuntimeStarted(
    deps,
    input.sessionId,
    manifest,
    { turnId: input.turnId, runId },
    resumedFromSuspensionId !== undefined,
  );

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

  const run = { manifest, input, runId, startTime };
  if (!loaded.handler) {
    return finalizeRuntimeFailure(
      { ...deps, hookPipeline },
      run,
      "Function runtime missing handler",
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
    runId,
    writeBuffer,
    pluginDataVisibility: createPluginDataVisibility({
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      writes: upstreamPluginData,
      ...(upstreamOf ? { upstreamOf } : {}),
      ...(deps.pluginDataReadProbe ? { probe: deps.pluginDataReadProbe } : {}),
    }),
  });
  const runtimeTools = runtimeContext.tools;

  await deps.emitter?.emit("function.executing", {
    ...helperCtx,
    recursionDepth,
    hasGateway: !!deps.gateway,
  });

  // Deadline race: without it a hung handler (e.g. a provider call that never
  // resolves) blocks the whole turn forever. The merged abort signal
  // (ctx.signal) lets a cooperative handler cancel its own in-flight provider
  // work; a non-cooperative one is detached with its capabilities revoked.
  const handler = loaded.handler;
  const output = await runLeasedInvocation(
    runtimeContext,
    () => handler.call(loaded, runtimeContext.context),
    {
      timeoutMs,
      timeoutMessage: `function runtime "${manifest.name}" timed out after ${timeoutMs}ms`,
      abortedMessage: `function runtime "${manifest.name}" was aborted`,
      completedMessage: `function runtime "${manifest.name}" completed`,
      // Function-layer terminal marker; the error is rethrown so the dispatch
      // catch emits the single runtime.failed (avoids a double terminal event).
      onFailure: async (err) => {
        await deps.emitter?.emit("function.completed", {
          ...helperCtx,
          status: "failed",
          durationMs: Date.now() - startTime,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    },
  );

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
  // A resumed handler may suspend again; the commit resolves the old record
  // and saves this one in one transaction.
  if (handlerOutcome.outcome === "suspended") {
    const suspensionId = crypto.randomUUID();
    // Nested results wait with the suspension and commit with the resume
    // that succeeds. A nested run that itself suspended cannot be resumed
    // from here, so it is dropped and traced.
    const nested = suspendNestedResults([
      ...restoredNested,
      ...runtimeContext.nestedResults,
    ]);
    for (const child of nested.dropped)
      await deps.emitter?.emit("recursive.failed", {
        ...helperCtx,
        depth: recursionDepth,
        code: "nested-suspension-dropped",
        nestedRuntimeId: child.runtimeId,
        error:
          "A nested run suspended inside a suspended parent; its suspension was dropped",
      });
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
        // A nested call reports progress under the root execution's scope.
        ...(executionId !== undefined &&
        executionId !== executionContext.executionId
          ? { progressScopeId: executionId }
          : {}),
        // `executeTurn` sets the player turns once it knows the whole execution.
        takenUnder: suspensionBasis(manifest, 0),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(logicalTurn !== undefined ? { logicalTurn } : {}),
        ...(nested.saved.length > 0 ? { nestedResults: nested.saved } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    return finalizeSuspension({ ...deps, hookPipeline }, run, {
      record: suspension,
      toolCalls: [],
    });
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
  // Results of its `ctx.recursiveCall`s follow the same rule.
  const ownSuccess =
    rawResult.status === "success" && result.status === "success";
  const completedResult: RuntimeResult =
    ownSuccess && writeBuffer.length > 0
      ? {
          ...result,
          pendingProposals: [
            ...(result.pendingProposals ?? []),
            ...writeBuffer,
          ],
        }
      : result;
  if (ownSuccess)
    attachNestedResults(completedResult, [
      ...restoredNested,
      ...runtimeContext.nestedResults,
    ]);
  if (ownSuccess)
    attachReadDependencies(completedResult, runtimeContext.readDependencies());

  const finalOutput = (completedResult.output ??
    getToolContent(output)) as Record<string, unknown>;

  if (deps.store)
    attachRuntimeJournal(completedResult, input, manifest, finalOutput);

  return completedResult;
}
