import { snapshotPlayerInput } from "../turn-executor/turn-digest.js";
import { createWorldModelView } from "../function-runtime/world-model-view.js";
import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  NestedTurnResult,
  RecursiveCallDelta,
} from "@covel/shared";
import {
  attachExecutionJournal,
  attachRuntimeTrigger,
} from "../execution-journal.js";
import {
  getRuntimeSpec,
  pluginMessagesFor,
  stageMessageOrder,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import { getToolContent, getPendingProposals } from "@covel/tools";
import type { HookPipeline } from "../hooks/pipeline.js";
import {
  createFunctionStoreView,
  createPluginLogger,
  createTrustedHandlerStore,
} from "../function-runtime/plugin-handler-helpers.js";
import { createExecutionWriteBuffer } from "../function-runtime/execution-write-buffer.js";
import { createRuntimeMediaContext } from "../function-runtime/runtime-media-context.js";
import { withUtilsTrace } from "../function-runtime/utils-trace.js";
import { finalizeRuntimeResult } from "../turn-executor/runtime-finalization.js";
import { resolveUserSettings } from "../turn-executor/turn-executor-helpers.js";
import {
  createAssetProgressEmitter,
  isTrustedPluginSource,
} from "../turn-executor/turn-runtime-helpers.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { createPluginRandom } from "../function-runtime/plugin-random.js";
import {
  combineAbortSignals,
  getTurnExecutionSignal,
  RuntimeTimeoutError,
} from "../turn-executor/turn-control.js";
import {
  withDefaultGatewaySignal,
  withDefaultUtilsSignal,
} from "../function-runtime/runtime-abort-boundaries.js";

export interface ExecuteAgentGuardOptions {
  readonly lastPlayerInput?:
    import("@covel/shared").PlayerInputSubmission | null;
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
   * Total-duration hard cap for the guard call (`manifest.timeoutMs` ??
   * executor default) — same contract as the function-runtime handler
   * deadline in `turn-function-runtime.ts`.
   */
  readonly timeoutMs: number;
}

export async function executeAgentGuard({
  lastPlayerInput = null,
  upstreamProposals = [],
  manifest,
  input,
  loaded,
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
    // Write-capability revocation. The guard gets its OWN abort
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
      inFlight.add(promise);
      void promise.then(
        () => inFlight.delete(promise),
        () => inFlight.delete(promise),
      );
      return promise;
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

    // Trusted-guard domain writes (schema import, player-character upsert) route
    // through this execution write buffer instead of hitting the store directly:
    // they are collected as proposals and flushed onto the skipped result below,
    // so they commit — and roll back — with the rest of the finalize
    // transaction. The same-turn main-loop follow-up that used to read a guard's
    // uncommitted direct write is gone (removed with the whole-turn transaction),
    // so nothing needs to see the write before commit. Reads overlay the buffer,
    // so a guard still observes its own not-yet-committed writes.
    const writeBuffer = createExecutionWriteBuffer();
    const world = deps.store
      ? await createWorldModelView(
          deps.worldModelReads ?? deps.store,
          input.sessionId,
          upstreamProposals,
          writeBuffer,
          assertLive,
          deps.dimensionContext,
        )
      : undefined;
    const guardStore = deps.store
      ? revocable(
          trustedGuard
            ? createTrustedHandlerStore(
                deps.store,
                guardHelperCtx,
                writeBuffer,
                world,
              )
            : createFunctionStoreView(deps.store, guardHelperCtx, writeBuffer),
        )
      : revocable(createFunctionStoreView(undefined, guardHelperCtx));
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
    // Combined signal: the player's turn abort OR the guard's own deadline.
    // A cooperative guard can observe either and cancel in-flight work.
    const externalSignal = getTurnExecutionSignal(deps.turnControl);
    const guardSignal =
      combineAbortSignals(externalSignal, guardAbort.signal) ??
      guardAbort.signal;
    const guardGateway = deps.gateway
      ? withDefaultGatewaySignal(deps.gateway, guardSignal)
      : undefined;
    const guardUtils = deps.utils
      ? withDefaultUtilsSignal(deps.utils, guardSignal)
      : undefined;
    // Trace plugin-owned provider HTTP calls from the guard handler too.
    const guardTracedUtils =
      guardUtils && deps.emitter
        ? withUtilsTrace(guardUtils, deps.emitter, guardHelperCtx)
        : guardUtils;
    const rawRecursiveCall = createRecursiveCall(guardSignal);
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
    const guardMessages = pluginMessagesFor(loaded.messages, input.locale);
    const guardPromise = loaded.guard({
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      playerMessage: input.playerMessage,
      session: {
        lastPlayerInput: snapshotPlayerInput(lastPlayerInput),
      },
      locale: input.locale,
      ...(guardMessages ? { messages: guardMessages } : {}),
      store: guardStore,
      world,
      recursiveCall: guardRecursiveCall,
      recursionDepth,
      ...(guardGateway && trustedGuard
        ? { gateway: revocable(guardGateway) }
        : {}),
      ...(guardTracedUtils && trustedGuard
        ? { utils: revocable(guardTracedUtils) }
        : {}),
      ...(deps.mediaStore && trustedGuard
        ? {
            media: revocable(
              createRuntimeMediaContext(deps.mediaStore, guardUtils, {
                sessionId: input.sessionId,
                pluginId: manifest.pluginId,
                signal: guardSignal,
              }),
            ),
          }
        : {}),
      ...(guardAssetProgress ? { assetProgress: guardAssetProgress } : {}),
      ...(guardManualPayload ? { manualPayload: guardManualPayload } : {}),
      ...(triggerEvent ? { triggerEvent } : {}),
      ...(guardUserSettings ? { userSettings: guardUserSettings } : {}),
      ...(guardLoggerHandle ? { logger: guardLoggerHandle } : {}),
      random: createPluginRandom({
        ...guardHelperCtx,
        stream: manifest.name,
      }),
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
    let removeAbortListener: (() => void) | undefined;
    let completedNormally = false;
    let rawGuardOutput: Awaited<typeof guardPromise>;
    try {
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => {
          const signalReason = guardSignal.reason;
          const reason =
            signalReason instanceof Error
              ? signalReason
              : new Error(`agent guard "${manifest.name}" aborted`);
          revoke(reason);
          reject(reason);
        };
        if (guardSignal.aborted) {
          onAbort();
          return;
        }
        guardSignal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          guardSignal.removeEventListener("abort", onAbort);
      });
      rawGuardOutput = await Promise.race([
        guardWork,
        aborted,
        new Promise<never>(() => {
          deadlineTimer = setTimeout(() => {
            const err = new RuntimeTimeoutError(
              `agent guard "${manifest.name}" timed out after ${timeoutMs}ms`,
            );
            // Revoke BEFORE rejecting: once the turn moves on, the still-
            // running guard must not be able to mutate state for a later
            // turn, and a cooperative guard sees the abort.
            revoke(err, true);
          }, timeoutMs);
        }),
      ]);
      completedNormally = true;
    } finally {
      clearTimeout(deadlineTimer);
      removeAbortListener?.();
      externalSignal?.removeEventListener("abort", revokeOnExternalAbort);
      // A guard's capabilities are a lease for this invocation. Revoke
      // retained handles even after successful completion.
      revoke(
        new Error(`agent guard "${manifest.name}" completed`),
        !completedNormally,
      );
      while (inFlight.size > 0) {
        await Promise.allSettled(inFlight);
      }
    }

    const guardOutput = getToolContent(rawGuardOutput);
    if (guardOutput.skip === true) {
      const pendingProposals = [
        ...getPendingProposals(rawGuardOutput),
        ...writeBuffer,
      ];

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
        ...(pendingProposals.length > 0 ? { pendingProposals } : {}),
        toolCalls: [],
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };

      const postResult = await finalizeRuntimeResult(
        { ...deps, hookPipeline },
        manifest,
        input,
        result,
        { outputContractSchema: loaded.outputContractSchema },
      );
      const postOutput = postResult.output as Record<string, unknown> | null;
      if (
        deps.store &&
        postResult.status === "skipped" &&
        typeof postOutput?.narrativeOutput === "string" &&
        postOutput.narrativeOutput
      ) {
        attachRuntimeTrigger(postResult, manifest.name);
        attachExecutionJournal(postResult, [
          {
            id: crypto.randomUUID(),
            sessionId: input.sessionId,
            turnId: input.turnId,
            sourceType: "runtime",
            sourcePluginId: manifest.pluginId,
            sourceRuntimeId: manifest.name,
            role: "assistant",
            name: manifest.name,
            content: postOutput.narrativeOutput,
            order: stageMessageOrder(getRuntimeSpec(manifest).stage),
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      return postResult;
    }
  }
  return undefined;
}
