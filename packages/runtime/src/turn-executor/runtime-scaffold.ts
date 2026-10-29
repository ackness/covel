/**
 * The execution scaffold shared by the runtime entry points.
 *
 * - The invocation lease ({@link runLeasedInvocation}) wraps a function
 *   handler or an agent guard: deadline, abort relay, capability revocation
 *   and settling un-awaited nested work.
 * - The failure terminals ({@link finalizeRuntimeFailure},
 *   {@link finalizeThrownRuntime}) finalize a failed result built before or
 *   around dispatch (missing handler, runtime not found, a thrown error).
 * - The suspension terminal ({@link finalizeSuspension}) finalizes a
 *   `suspended` result and carries its continuation as an execution-local
 *   artifact that `finalizeExecution` persists.
 *
 * An agent's own deadline is not this lease. `agent-loop-budget.ts` keeps a
 * pausable budget that excludes model-slot queue and stream time, and the
 * tool loop checks it at step boundaries; only the agent's guard runs under
 * the lease.
 */

import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";
import type { PluginRuntimeContext } from "../function-runtime/plugin-runtime-context.js";
import { attachSuspensionArtifact } from "../suspension-artifact.js";
import { finalizeRuntimeResult } from "./runtime-finalization.js";
import { RuntimeTimeoutError } from "./turn-control.js";
import { makeFailedResult } from "./turn-executor-helpers.js";

/** Total-duration cap for a runtime that neither its manifest nor the caller sets. */
export const DEFAULT_RUNTIME_TIMEOUT_MS = 60000;

/** A dispatched runtime's deadline: its manifest's, else the executor's. */
export function resolveRuntimeTimeoutMs(
  manifest: Pick<RuntimeManifest, "timeoutMs">,
  fallback: number,
): number {
  return manifest.timeoutMs ?? fallback;
}

type FinalizationDeps = Parameters<typeof finalizeRuntimeResult>[0];
type FinalizationOptions = NonNullable<
  Parameters<typeof finalizeRuntimeResult>[4]
>;

/** The invocation-scoped part of a plugin runtime context. */
export type InvocationLease = Pick<
  PluginRuntimeContext,
  "abort" | "revoke" | "dispose" | "drain"
>;

export interface LeasedInvocationOptions {
  readonly timeoutMs: number;
  /** Aborts the invocation with a `RuntimeTimeoutError` when the deadline passes. */
  readonly timeoutMessage: string;
  /** Rejects with this when the abort reason is not an `Error`. */
  readonly abortedMessage: string;
  /** Aborts the invocation signal once the race settles, if nothing else did. */
  readonly completedMessage: string;
  /**
   * Runs when the race rejects, before the lease is released, and the error
   * is then rethrown.
   */
  readonly onFailure?: (error: unknown) => Promise<void>;
}

/**
 * Run one handler or guard invocation under its lease.
 *
 * The work races the abort signal and the deadline. A handler may launch a
 * nested turn or tool call without awaiting it, so the work also drains the
 * lease before it resolves, under the same deadline. Promise.race keeps the
 * work subscribed, so a rejection after the deadline is still observed. A
 * non-cooperative losing handler keeps running detached, but its
 * capabilities are revoked: synchronously with the abort, so no capability
 * call can enter during the rejection microtask, and again once the race
 * settles.
 */
export async function runLeasedInvocation<T>(
  lease: InvocationLease,
  work: () => Promise<T>,
  opts: LeasedInvocationOptions,
): Promise<T> {
  const invocationAbort = lease.abort;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    const leasedWork = work().then(async (result) => {
      await lease.drain();
      return result;
    });
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => {
        lease.revoke();
        const reason = invocationAbort.signal.reason;
        reject(
          reason instanceof Error ? reason : new Error(opts.abortedMessage),
        );
      };
      if (invocationAbort.signal.aborted) {
        onAbort();
        return;
      }
      invocationAbort.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () =>
        invocationAbort.signal.removeEventListener("abort", onAbort);
    });
    return await Promise.race([
      leasedWork,
      aborted,
      new Promise<never>(() => {
        deadlineTimer = setTimeout(() => {
          invocationAbort.abort(new RuntimeTimeoutError(opts.timeoutMessage));
        }, opts.timeoutMs);
      }),
    ]);
  } catch (error) {
    // Await only a real callback: an extra tick here would let a microtask
    // the failed work queued use its capabilities before `finally` revokes.
    if (opts.onFailure) await opts.onFailure(error);
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    removeAbortListener?.();
    lease.dispose();
    // The race has settled: no further capability use is legitimate, whether
    // the work won (its output is final) or lost (it is detached).
    lease.revoke();
    if (!invocationAbort.signal.aborted) {
      invocationAbort.abort(new Error(opts.completedMessage));
    }
    // The work already propagates tool failures. Cleanup must settle
    // outstanding calls without replacing the original timeout or error.
    await lease.drain().catch(() => undefined);
  }
}

/** Identity of the run a terminal result belongs to. */
export interface RuntimeRun {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly runId: string;
  readonly startTime: number;
}

/**
 * Finalize a failed result with `error`. Each caller passes the deps it
 * finalizes with elsewhere, and the options its path uses: finalization
 * branches on which option keys are present.
 */
export function finalizeRuntimeFailure(
  deps: FinalizationDeps,
  run: RuntimeRun,
  error: string,
  finalizeOptions?: FinalizationOptions,
): Promise<RuntimeResult> {
  const { manifest, input, runId, startTime } = run;
  return finalizeRuntimeResult(
    deps,
    manifest,
    input,
    makeFailedResult(manifest, input, runId, startTime, error),
    finalizeOptions,
  );
}

/** Finalize a thrown error, keeping it as the cause for classification. */
export function finalizeThrownRuntime(
  deps: FinalizationDeps,
  run: RuntimeRun,
  error: unknown,
  finalizeOptions?: FinalizationOptions,
): Promise<RuntimeResult> {
  return finalizeRuntimeFailure(
    deps,
    run,
    error instanceof Error ? error.message : String(error),
    { ...finalizeOptions, cause: error },
  );
}

/**
 * Finalize a `suspended` result for `record`. The continuation is attached to
 * the finalized object itself, so `collectExecutionSuspensionRuns` maps it to
 * this run; a PostRuntime hook that changes the status drops it.
 */
export async function finalizeSuspension(
  deps: FinalizationDeps,
  run: RuntimeRun,
  suspension: {
    readonly record: SuspensionRecord;
    readonly toolCalls: RuntimeResult["toolCalls"];
    /** How an agent loop ended; function runtimes leave it out. */
    readonly stop?: RuntimeResult["stop"];
  },
  finalizeOptions?: FinalizationOptions,
): Promise<RuntimeResult> {
  const { manifest, input, runId, startTime } = run;
  const { record } = suspension;
  const suspendedResult: RuntimeResult = {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: "suspended",
    output: {
      suspended: true,
      suspensionId: record.id,
      reason: record.reason,
      resumeSchema: record.resumeSchema,
    },
    toolCalls: suspension.toolCalls,
    durationMs: Date.now() - startTime,
    ...(suspension.stop ? { stop: suspension.stop } : {}),
    timestamp: new Date().toISOString(),
  };
  const finalResult = await finalizeRuntimeResult(
    deps,
    manifest,
    input,
    suspendedResult,
    finalizeOptions,
  );
  return finalResult.status === "suspended"
    ? attachSuspensionArtifact(finalResult, { record })
    : finalResult;
}
