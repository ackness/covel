/**
 * Unified non-streaming operation runner shared by the gateway's
 * text / object / speech / transcription / embed / image paths.
 *
 * Each of those operations repeats the same skeleton:
 *
 *   apply slot overlay
 *     → resolve slot/preset id (slot fallback)
 *     → resolve one or more targets
 *     → per target: resolve provider + inject api keys
 *                    → notifyStart → adapter call → notifySuccess
 *                    → on failure: notifyError + (maybe) fall back
 *
 * `runOperation` factors that skeleton into one place. Operations differ
 * only in four axes, expressed by {@link OperationSpec}:
 *
 *   - `mode` / `fallbackTag` — lifecycle + slot-resolution tags.
 *   - `resolveTargets` — single target vs. a fallback chain.
 *   - `prepare` — how a target maps to a provider resolution (embed routes
 *      via the bare provider name; everything else via preset/profile).
 *   - `execute` / `resolveUsage` — the adapter call and its usage telemetry.
 *
 * A single-element target list collapses to a plain "single call, no
 * fallback" because `canFallback` is `index < targets.length - 1` (i.e.
 * `0 < 0 === false`), so the first failure rethrows immediately — exactly
 * the old `runSingle` behaviour.
 *
 * The streaming path (`streamText`) is intentionally NOT routed through
 * here: it is an async generator with delta-aware fallback semantics (it
 * can no longer retry once a delta has been emitted), which does not fit
 * the request/response shape below.
 */

import { AiProviderError } from "./errors.js";
import { assertProviderCredentials } from "./provider-credentials.js";
import {
  acquireLLMSlot,
  type LLMSlot,
  assertLlmRequestBudget,
  awaitLlmRequest,
  createLlmRequestScope,
} from "@covel/shared";
import type { ProviderResolution } from "./provider-registry.js";
import {
  notifyStart,
  notifySuccess,
  notifyTargetAttempt,
  targetModel,
} from "./gateway-lifecycle.js";
import {
  createFailedAccountTracker,
  handleTargetFailure,
  preparationFailure,
  prepareTargetAsync,
  tryRefreshSourceTarget,
  withProviderSourceAccounts,
} from "./gateway-fallback-chain.js";
import type { ProviderRegistryLike } from "./gateway-fallback-chain.js";
import type {
  ProviderSourceAttemptContext,
  ProviderSourceResolver,
} from "./provider-source.js";
import {
  applyRequestCapabilityOverlay,
  applySlotOverlay,
} from "./slot-overlay.js";
import type { OverlayDeps } from "./slot-overlay.js";
import {
  activeProviderSources,
  type GatewayOptions,
} from "./gateway-slot-resolution.js";
import type { OperationMode, ResolvedTarget, UsageSummary } from "./types.js";

/**
 * Dependency surface `runOperation` needs: overlay-capable registries plus
 * a provider registry that can `resolve` / `withApiKeys`. The gateway's
 * full dependency object is structurally assignable to this.
 */
export interface RunOperationDeps extends OverlayDeps {
  readonly providerRegistry: ProviderRegistryLike;
  readonly providerSources?: ProviderSourceResolver;
  readonly getProviderSources?: () => ProviderSourceResolver | undefined;
}

/** Slot-resolution helper signature (see `createGatewaySlotResolution`). */
type ResolveSlotOrPassthrough = (
  presetId: string | undefined,
  fallbackTag: string | undefined,
  options: GatewayOptions | undefined,
) => string | undefined;

export interface OperationSpec<TResult> {
  /** Caller's requested preset/slot id (fed through slot resolution). */
  readonly presetId: string | undefined;
  /** Operation mode — drives provider resolution and lifecycle hooks. */
  readonly mode: OperationMode;
  /** Tag used by slot fallback resolution (e.g. text / embedding / speech). */
  readonly fallbackTag: string;
  /**
   * Resolve the effective preset id into one or more ordered targets.
   * A multi-element list drives provider fallback; a single-element list
   * collapses to one call with no fallback.
   */
  resolveTargets(effectivePresetId: string | undefined): ResolvedTarget[];
  /**
   * Run the adapter call against a resolved target. `primary` is the first
   * target of the chain, the one a caller's capability checks were about.
   */
  execute(
    target: ResolvedTarget,
    resolved: ProviderResolution,
    primary: ResolvedTarget,
  ): Promise<TResult>;
  /**
   * Map a successful result to its usage summary for lifecycle hooks.
   * Operations without usage telemetry omit this — it defaults to `null`.
   */
  resolveUsage?(result: TResult): UsageSummary | null;
  /**
   * Override how a target is resolved into a provider resolution and which
   * provider name receives the request keys. Defaults to `prepareTargetAsync`.
   */
  prepare?(
    target: ResolvedTarget,
    options: GatewayOptions | undefined,
  ):
    | import("./gateway-fallback-chain.js").PreparedTarget
    | Promise<import("./gateway-fallback-chain.js").PreparedTarget>;
}

export interface GatewayRunOperation {
  runOperation<TResult>(
    spec: OperationSpec<TResult>,
    options: GatewayOptions | undefined,
  ): Promise<TResult>;
}

interface TargetExecutionState {
  resolved: ProviderResolution;
  resolvedForFailure: ProviderResolution;
  sourceAttempt: ProviderSourceAttemptContext | undefined;
}

function applyScopeConfig(
  resolved: ProviderResolution,
  scope: ReturnType<typeof createLlmRequestScope> | undefined,
): ProviderResolution {
  if (!scope) return resolved;
  return {
    ...resolved,
    config: {
      ...resolved.config,
      requestBudget: scope.budget,
      signal: resolved.config.signal
        ? AbortSignal.any([resolved.config.signal, scope.signal])
        : scope.signal,
    },
  };
}

async function executeTargetWithRefresh<TResult>(args: {
  readonly spec: OperationSpec<TResult>;
  readonly target: ResolvedTarget;
  readonly primary: ResolvedTarget;
  readonly provider: string;
  readonly state: TargetExecutionState;
  readonly scope: ReturnType<typeof createLlmRequestScope> | undefined;
  readonly providerRegistry: ProviderRegistryLike;
  readonly providerSources: ProviderSourceResolver | undefined;
  readonly resolveUsage: (result: TResult) => UsageSummary | null;
  readonly startTime: number;
  readonly options: GatewayOptions | undefined;
}): Promise<TResult> {
  const {
    spec,
    target,
    primary,
    provider,
    state,
    scope,
    providerRegistry,
    providerSources,
    resolveUsage,
    startTime,
    options,
  } = args;

  notifyTargetAttempt(options?.onTargetAttempt, target);
  assertProviderCredentials(provider, state.resolvedForFailure);
  let refreshedOnce = false;
  let started = false;

  // At most one token refresh+retry on HTTP 401 for source-backed calls.
  while (true) {
    const attemptResolved = applyScopeConfig(state.resolved, scope);
    state.resolvedForFailure = attemptResolved;
    let slot: LLMSlot | undefined;
    try {
      if (["text", "object", "evaluate"].includes(spec.mode)) {
        slot = await acquireLLMSlot(
          scope?.signal ?? options?.signal,
          options?.onQueueStart,
        );
      }
      if (scope) {
        assertLlmRequestBudget(scope.budget, {
          signal: scope.signal,
          requireAttempt: true,
        });
      }
      if (!started) {
        started = true;
        await notifyStart(
          attemptResolved.hooks,
          provider,
          attemptResolved.protocol,
          spec.mode,
          targetModel(target),
          options?.traceId,
          options,
        );
      }
      const result = await awaitLlmRequest(
        spec.execute(target, attemptResolved, primary),
        scope?.signal ?? options?.signal,
      );
      await notifySuccess(
        attemptResolved.hooks,
        provider,
        attemptResolved.protocol,
        spec.mode,
        targetModel(target),
        resolveUsage(result),
        Date.now() - startTime,
        options?.traceId,
        options,
      );
      return result;
    } catch (error) {
      slot?.release();
      slot = undefined;
      if (!refreshedOnce && state.sourceAttempt) {
        const refreshed = await tryRefreshSourceTarget({
          providerRegistry,
          providerSources,
          provider,
          mode: spec.mode,
          model: targetModel(target),
          sourceAttempt: state.sourceAttempt,
          error,
          signal: scope?.signal ?? options?.signal,
        });
        if (refreshed) {
          refreshedOnce = true;
          state.resolved = refreshed.resolved;
          state.sourceAttempt = refreshed.sourceAttempt;
          continue;
        }
      }
      throw error;
    } finally {
      slot?.release();
    }
  }
}

/**
 * Build the shared `runOperation` runner bound to the gateway's
 * dependencies and slot resolver.
 */
export function createRunOperation(
  deps: RunOperationDeps,
  resolveSlotOrPassthrough: ResolveSlotOrPassthrough,
): GatewayRunOperation {
  async function runOperation<TResult>(
    spec: OperationSpec<TResult>,
    options: GatewayOptions | undefined,
  ): Promise<TResult> {
    // Media backends own longer task/polling deadlines; only an explicit
    // budget opts them into this transport ceiling. An embedding is one
    // short request like a text call, and it runs in background sweeps and
    // in a search on the turn path, where an endpoint that never answers
    // would otherwise hold the caller with no limit.
    const scope =
      options?.requestBudget ||
      ["text", "object", "evaluate", "embed"].includes(spec.mode)
        ? createLlmRequestScope({
            budget: options?.requestBudget,
            signal: options?.signal,
          })
        : undefined;
    if (scope)
      options = {
        ...options,
        requestBudget: scope.budget,
        signal: scope.signal,
      };
    let cleanup = () => {};
    try {
      cleanup = applySlotOverlay(deps, options?.slotOverrides);
      const effectivePresetId = resolveSlotOrPassthrough(
        spec.presetId,
        spec.fallbackTag,
        options,
      );
      const providerSources = activeProviderSources(deps);
      const resolvedTargets = spec
        .resolveTargets(effectivePresetId)
        .map((target, index) =>
          applyRequestCapabilityOverlay(
            target,
            spec.presetId,
            options?.slotOverrides,
            options?.capabilityOverridePolicy ?? "restrict-only",
            index === 0,
          ),
        );
      const resolveUsage = spec.resolveUsage ?? (() => null);
      const targets = await withProviderSourceAccounts(
        resolvedTargets,
        providerSources,
        options?.signal,
      );
      let lastError: AiProviderError | null = null;
      const failedAccounts = createFailedAccountTracker();

      for (const [index, target] of targets.entries()) {
        let preparedTarget;
        try {
          preparedTarget = spec.prepare
            ? await spec.prepare(target, options)
            : await prepareTargetAsync(
                deps.providerRegistry,
                providerSources,
                target,
                spec.mode,
                options,
              );
        } catch (error) {
          lastError = preparationFailure(
            error,
            target,
            options,
            index < targets.length - 1,
          );
          continue;
        }
        const provider = preparedTarget.provider;
        const state: TargetExecutionState = {
          resolved: preparedTarget.resolved,
          resolvedForFailure: applyScopeConfig(preparedTarget.resolved, scope),
          sourceAttempt: preparedTarget.sourceAttempt,
        };
        if (failedAccounts.has(provider, state.resolved)) continue;

        const startTime = Date.now();
        try {
          return await executeTargetWithRefresh({
            spec,
            target,
            primary: targets[0]!,
            provider,
            state,
            scope,
            providerRegistry: deps.providerRegistry,
            providerSources,
            resolveUsage,
            startTime,
            options,
          });
        } catch (error) {
          lastError = await handleTargetFailure({
            error,
            resolved: state.resolvedForFailure,
            provider,
            mode: spec.mode,
            target,
            startTime,
            options,
            canFallback: index < targets.length - 1,
            previous: lastError,
            sourceAttempt: state.sourceAttempt,
            failedAccounts,
          });
        }
      }

      throw (
        lastError ??
        new AiProviderError({
          code: "PROVIDER_ERROR",
          message: "No model target resolved.",
          provider: "unknown",
          retriable: false,
        })
      );
    } finally {
      cleanup();
      scope?.dispose();
    }
  }

  return { runOperation };
}
