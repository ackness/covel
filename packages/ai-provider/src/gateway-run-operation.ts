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
import type { ProviderResolution } from "./provider-registry.js";
import {
  notifyStart,
  notifySuccess,
  targetModel,
} from "./gateway-lifecycle.js";
import {
  handleTargetFailure,
  prepareTarget,
} from "./gateway-fallback-chain.js";
import type { ProviderRegistryLike } from "./gateway-fallback-chain.js";
import { applySlotOverlay } from "./slot-overlay.js";
import type { OverlayDeps } from "./slot-overlay.js";
import type { GatewayOptions } from "./gateway-slot-resolution.js";
import type { OperationMode, ResolvedTarget, UsageSummary } from "./types.js";

/**
 * Dependency surface `runOperation` needs: overlay-capable registries plus
 * a provider registry that can `resolve` / `withApiKeys`. The gateway's
 * full dependency object is structurally assignable to this.
 */
export interface RunOperationDeps extends OverlayDeps {
  readonly providerRegistry: OverlayDeps["providerRegistry"] &
    ProviderRegistryLike;
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
  /** Run the adapter call against a resolved target. */
  execute(
    target: ResolvedTarget,
    resolved: ProviderResolution,
  ): Promise<TResult>;
  /**
   * Map a successful result to its usage summary for lifecycle hooks.
   * Operations without usage telemetry omit this — it defaults to `null`.
   */
  resolveUsage?(result: TResult): UsageSummary | null;
  /**
   * Override how a target is resolved into a provider resolution and which
   * provider name receives the request keys. Defaults to `prepareTarget`
   * (routing target = `preset ?? profile`, key provider = preset/profile
   * provider). `embed` overrides this to route via the bare provider name.
   */
  prepare?(
    target: ResolvedTarget,
    options: GatewayOptions | undefined,
  ): { provider: string; resolved: ProviderResolution };
}

export interface GatewayRunOperation {
  runOperation<TResult>(
    spec: OperationSpec<TResult>,
    options: GatewayOptions | undefined,
  ): Promise<TResult>;
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
    const cleanup = applySlotOverlay(deps, options?.slotOverrides);
    try {
      const effectivePresetId = resolveSlotOrPassthrough(
        spec.presetId,
        spec.fallbackTag,
        options,
      );
      const targets = spec.resolveTargets(effectivePresetId);
      const resolveUsage = spec.resolveUsage ?? (() => null);
      let lastError: AiProviderError | null = null;

      for (const [index, target] of targets.entries()) {
        const { provider, resolved } = spec.prepare
          ? spec.prepare(target, options)
          : prepareTarget(deps.providerRegistry, target, spec.mode, options);

        const startTime = Date.now();

        try {
          await notifyStart(
            resolved.hooks,
            provider,
            resolved.protocol,
            spec.mode,
            targetModel(target),
            options?.traceId,
          );
          const result = await spec.execute(target, resolved);
          await notifySuccess(
            resolved.hooks,
            provider,
            resolved.protocol,
            spec.mode,
            targetModel(target),
            resolveUsage(result),
            Date.now() - startTime,
            options?.traceId,
          );
          return result;
        } catch (error) {
          lastError = await handleTargetFailure({
            error,
            resolved,
            provider,
            mode: spec.mode,
            target,
            startTime,
            options,
            canFallback: index < targets.length - 1,
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
    }
  }

  return { runOperation };
}
