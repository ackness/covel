import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import type { HookPipeline } from "../hooks/pipeline.js";
import {
  createFunctionStoreView,
  createPluginDataWriter,
  createPluginLogger,
} from "../function-runtime/plugin-handler-helpers.js";
import { createRuntimeMediaContext } from "../function-runtime/runtime-media-context.js";
import { withUtilsTrace } from "../function-runtime/utils-trace.js";
import { runPostRuntimeHook } from "../hooks/wire-helpers.js";
import { resolveUserSettings } from "../turn-executor/turn-executor-helpers.js";
import {
  createAssetProgressEmitter,
  emitSubEvent,
  isTrustedPluginSource,
} from "../turn-executor/turn-runtime-helpers.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { NARRATOR_PRIORITY } from "../schedule/scheduler.js";

export interface ExecuteAgentGuardOptions {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly loaded: LoadedRuntime;
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  readonly deps: TurnExecutorDeps;
  readonly hookPipeline: HookPipeline | undefined;
  readonly triggerEvent:
    | {
        readonly topic: string;
        readonly data: Readonly<Record<string, unknown>>;
      }
    | undefined;
  readonly createRecursiveCall: () => (
    delta: Partial<TurnInput>,
    opts?: { readonly reason?: string },
  ) => Promise<TurnResult>;
  readonly recursionDepth: number;
  readonly startTime: number;
  readonly runId: string;
  /**
   * Total-duration hard cap for the guard call (`manifest.timeoutMs` ??
   * executor default) — same contract as the function-runtime handler
   * deadline in `turn-function-runtime.ts`.
   */
  readonly timeoutMs: number;
}

export async function executeAgentGuard({
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
}: ExecuteAgentGuardOptions): Promise<RuntimeResult | undefined> {
  // ── Guard: pre-execution gate for agent runtimes ────────────
  if (loaded.guard) {
    const guardConfig = deps.getConfig(manifest.pluginId, manifest.name);
    const guardManualPayload =
      input.manualTrigger?.runtimeId === manifest.name
        ? input.manualTrigger.payload
        : undefined;
    const guardUserSettings = resolveUserSettings(manifest, input.userSettings);
    const guardHelperCtx = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
    };
    const rawAssetProgress = createAssetProgressEmitter(deps.emitter, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
    });
    // Trace plugin-owned provider HTTP calls from the guard handler too.
    const guardTracedUtils =
      deps.utils && deps.emitter
        ? withUtilsTrace(deps.utils, deps.emitter, guardHelperCtx)
        : deps.utils;

    // H-11: write-capability revocation. The guard gets its OWN abort
    // controller, and every write-capable capability handed to it (store,
    // pluginData, logger, gateway, media, assetProgress, recursiveCall) is
    // wrapped so that once the deadline fires, any further call throws.
    // Promise.race alone only unblocked the turn — the timed-out guard kept
    // running with live handles and could race a LATER turn's writes.
    const guardAbort = new AbortController();
    const trustedGuard = isTrustedPluginSource(deps, manifest);
    const inFlight = new Set<Promise<unknown>>();
    let revokedReason: Error | undefined;
    const revoke = (reason: Error, abortSignal = false): void => {
      revokedReason ??= reason;
      if (abortSignal && !guardAbort.signal.aborted) guardAbort.abort(reason);
    };
    const assertLive = (): void => {
      if (revokedReason) {
        throw new Error(`${revokedReason.message} — write capability revoked`);
      }
    };
    const trackPromise = <T>(promise: Promise<T>): Promise<T> => {
      const tracked = promise.finally(() => inFlight.delete(tracked));
      inFlight.add(tracked);
      return tracked;
    };
    const revocable = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(t, prop, receiver) {
          const value = Reflect.get(t, prop, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            assertLive();
            const result = Reflect.apply(
              value as (...a: unknown[]) => unknown,
              t,
              args,
            );
            if (result instanceof Promise) {
              return trackPromise(
                result.then((resolved) => {
                  assertLive();
                  return resolved;
                }),
              );
            }
            assertLive();
            return result;
          };
        },
      });

    const guardStore = deps.store
      ? revocable(
          trustedGuard
            ? deps.store
            : createFunctionStoreView(deps.store, guardHelperCtx),
        )
      : undefined;
    const guardPluginDataHandle =
      deps.store && trustedGuard
        ? revocable(createPluginDataWriter(deps.store, guardHelperCtx))
        : undefined;
    const guardLoggerHandle =
      deps.store && trustedGuard
        ? revocable(createPluginLogger(deps.store, guardHelperCtx))
        : undefined;
    const guardAssetProgress: typeof rawAssetProgress =
      rawAssetProgress && trustedGuard
        ? (progress) => {
            assertLive();
            const result = rawAssetProgress(progress);
            return result instanceof Promise ? trackPromise(result) : result;
          }
        : undefined;
    const rawRecursiveCall = createRecursiveCall();
    const guardRecursiveCall: typeof rawRecursiveCall = (delta, opts) => {
      assertLive();
      if (!trustedGuard) {
        return Promise.reject(
          new Error(
            `community agent guard "${manifest.name}" cannot start recursive turns`,
          ),
        );
      }
      return trackPromise(rawRecursiveCall(delta, opts));
    };
    // Combined signal: the player's turn abort OR the guard's own deadline.
    // A cooperative guard can observe either and cancel in-flight work.
    const externalSignal = deps.turnControl?.signal;
    const guardSignal = externalSignal
      ? AbortSignal.any([externalSignal, guardAbort.signal])
      : guardAbort.signal;
    const revokeOnExternalAbort = (): void => {
      const reason = externalSignal?.reason;
      revoke(
        reason instanceof Error
          ? reason
          : new Error(`agent guard "${manifest.name}" aborted`),
      );
    };
    if (externalSignal?.aborted) revokeOnExternalAbort();
    else
      externalSignal?.addEventListener("abort", revokeOnExternalAbort, {
        once: true,
      });

    // Deadline race — mirrors the function-runtime handler pattern in
    // `turn-function-runtime.ts`: without it a hung guard blocks the whole
    // turn (and the session lock) forever. Promise.race keeps the guard
    // promise subscribed, so a post-timeout rejection is still observed.
    const guardPromise = loaded.guard({
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      playerMessage: input.playerMessage,
      locale: input.locale,
      store: guardStore,
      completedResults,
      config: guardConfig,
      recursiveCall: guardRecursiveCall,
      recursionDepth,
      ...(deps.gateway && trustedGuard
        ? { gateway: revocable(deps.gateway) }
        : {}),
      ...(guardTracedUtils && trustedGuard
        ? { utils: revocable(guardTracedUtils) }
        : {}),
      ...(deps.mediaStore && trustedGuard
        ? {
            media: revocable(
              createRuntimeMediaContext(deps.mediaStore, deps.utils, {
                sessionId: input.sessionId,
                pluginId: manifest.pluginId,
              }),
            ),
          }
        : {}),
      ...(guardAssetProgress ? { assetProgress: guardAssetProgress } : {}),
      ...(guardManualPayload ? { manualPayload: guardManualPayload } : {}),
      ...(triggerEvent ? { triggerEvent } : {}),
      ...(guardUserSettings ? { userSettings: guardUserSettings } : {}),
      ...(guardPluginDataHandle ? { pluginData: guardPluginDataHandle } : {}),
      ...(guardLoggerHandle ? { logger: guardLoggerHandle } : {}),
      signal: guardSignal,
    });
    const guardWork = guardPromise.then(async (output) => {
      // A trusted guard may intentionally launch a capability call without
      // awaiting it. Keep the lease (and deadline) active until all calls
      // observed by our wrappers settle.
      while (inFlight.size > 0) {
        await Promise.allSettled(inFlight);
      }
      assertLive();
      return output;
    });
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let guardOutput: Awaited<typeof guardPromise>;
    try {
      guardOutput = await Promise.race([
        guardWork,
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            const err = new Error(
              `agent guard "${manifest.name}" timed out after ${timeoutMs}ms`,
            );
            // Revoke BEFORE rejecting: once the turn moves on, the still-
            // running guard must not be able to mutate state for a later
            // turn (H-11), and a cooperative guard sees the abort.
            revoke(err, true);
            reject(err);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(deadlineTimer);
      externalSignal?.removeEventListener("abort", revokeOnExternalAbort);
      // A guard's capabilities are a lease for this invocation. Revoke
      // retained handles even after successful completion.
      revoke(new Error(`agent guard "${manifest.name}" completed`));
    }

    if (guardOutput.skip === true) {
      // Record `skipped` in the internal RuntimeResult so downstream
      // consumers (Pre-Game completion tracker, session-kernel's
      // `result.status !== 'success'` gate, SSE payload) all see the same
      // story. Earlier code set `status: 'success'` here and only reported
      // 'skipped' in the outgoing SSE, which made the Pre-Game tracker's
      // `guardSkipped = result.status === 'skipped'` check dead code.
      const result: RuntimeResult = {
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        runId,
        turnId: input.turnId,
        status: "skipped",
        output: guardOutput,
        toolCalls: [],
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };

      if (
        deps.store &&
        typeof guardOutput.narrativeOutput === "string" &&
        guardOutput.narrativeOutput
      ) {
        await deps.store.appendTurnMessage({
          id: crypto.randomUUID(),
          sessionId: input.sessionId,
          turnId: input.turnId,
          sourceType: "runtime",
          sourcePluginId: manifest.pluginId,
          sourceRuntimeId: manifest.name,
          role: "assistant",
          name: manifest.name,
          content: guardOutput.narrativeOutput as string,
          order: manifest.priority ?? NARRATOR_PRIORITY,
          createdAt: new Date().toISOString(),
        });
      }

      // Guard skipped: emit completed (without ever emitting started) so frontend
      // shows "skipped" instead of an infinite spinner.
      try {
        await deps.onRuntimeComplete?.({
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          status: "skipped",
          durationMs: result.durationMs,
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
          durationMs: result.durationMs,
        },
      );

      // PostRuntime hook — guard-skipped path (S4-T3)
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
        result,
      );
    }
  }
  return undefined;
}
