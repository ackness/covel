/**
 * Fallback-chain helpers shared by the gateway's text/object and streaming
 * paths.
 *
 * Both `streamTextInner` and `runWithFallbackInner` walk the same resolved
 * target chain and apply the same per-target failure handling
 * (notifyError → normalizeError → fallback decision). This module factors out
 * that duplication so behaviour stays identical across the two paths.
 */

import { AiProviderError } from "./errors.js";
import type { ProviderResolution } from "./provider-registry.js";
import {
  normalizeError,
  notifyError,
  shouldFallback,
  targetModel,
  targetProvider,
} from "./gateway-lifecycle.js";
import type { GatewayOptions } from "./gateway-slot-resolution.js";
import type {
  OperationMode,
  ProviderProtocol,
  ResolvedTarget,
} from "./types.js";

/** Subset of the provider registry the fallback chain depends on. */
export interface ProviderRegistryLike {
  resolve(
    target: {
      provider: string;
      baseUrl?: string;
      protocol?: ProviderProtocol;
    },
    options?: { mode: OperationMode },
  ): ProviderResolution;
  withApiKeys(
    resolution: ProviderResolution,
    apiKeys: Record<string, string>,
    providerName: string,
    envApiKeys?: Record<string, string>,
  ): ProviderResolution;
}

/**
 * Resolve a target into its provider resolution, applying per-request API keys
 * when supplied. Identical setup used by both fallback paths.
 */
export function prepareTarget(
  providerRegistry: ProviderRegistryLike,
  target: ResolvedTarget,
  mode: OperationMode,
  options: GatewayOptions | undefined,
): { provider: string; resolved: ProviderResolution } {
  const provider = targetProvider(target);
  let resolved = providerRegistry.resolve(target.preset ?? target.profile, {
    mode,
  });
  if (options?.apiKeys || options?.envApiKeys) {
    resolved = providerRegistry.withApiKeys(
      resolved,
      options.apiKeys ?? {},
      provider,
      options.envApiKeys,
    );
  }
  return { provider, resolved };
}

/**
 * Apply the shared per-target failure handling.
 *
 * Notifies the lifecycle hooks, normalizes the error, and decides — given the
 * caller-supplied `canFallback` predicate — whether to rethrow now or let the
 * caller advance to the next target. Returns the normalized error so the caller
 * can retain it as `lastError`.
 *
 * Throws the normalized error when the caller must stop (last target, a
 * non-retriable error, or a path-specific guard such as already-emitted deltas).
 */
export async function handleTargetFailure(args: {
  error: unknown;
  resolved: ProviderResolution;
  provider: string;
  mode: OperationMode;
  target: ResolvedTarget;
  startTime: number;
  options: GatewayOptions | undefined;
  /**
   * Whether falling back to the next target is permitted at this point. The
   * streaming path passes `false` once a delta has been emitted; both paths
   * pass `false` for the final target or a non-fallbackable error.
   */
  canFallback: boolean;
}): Promise<AiProviderError> {
  const {
    error,
    resolved,
    provider,
    mode,
    target,
    startTime,
    options,
    canFallback,
  } = args;

  await notifyError(
    resolved.hooks,
    provider,
    resolved.protocol,
    mode,
    targetModel(target),
    error,
    Date.now() - startTime,
    options?.traceId,
  );

  const normalized = normalizeError(error, provider);

  if (!canFallback || !shouldFallback(normalized)) {
    throw normalized;
  }

  return normalized;
}
