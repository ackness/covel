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
import {
  assertLlmRequestBudget,
  awaitLlmRequest,
  type ProviderFailureKind,
} from "@covel/shared";
import { classifyProviderFailure } from "./provider-failure.js";
import type { ProviderResolution } from "./provider-registry.js";
import {
  hasSameOrigin,
  readSourceWireErrorContext,
  type ProviderSourceAttemptContext,
  type ProviderSourceResolver,
} from "./provider-source.js";
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
  ProviderConfig,
  ProviderProtocol,
  ResolvedTarget,
} from "./types.js";

/**
 * A missing/refused key (401) or empty balance fails every model of the account, so
 * a backup with the same provider, base URL and key is skipped (or same
 * `(sourceId, accountId)` when backed by a plugin provider source). A 403 or a
 * rate limit can apply to one model only, so such a backup still runs.
 */
function failsWholeAccount(error: unknown): boolean {
  const failure = classifyProviderFailure(error);
  return (
    failure.kind === "missing_key" ||
    failure.kind === "quota" ||
    (failure.kind === "auth" && failure.statusCode === 401)
  );
}

type FailedAccountIdentity =
  | {
      readonly kind: "source";
      readonly sourceId: string;
      readonly accountId: string;
    }
  | {
      readonly kind: "key";
      readonly provider: string;
      readonly baseUrl?: string;
      readonly apiKey?: string;
    };

/** Per-call account failures; credentials never enter diagnostics or traces. */
export function createFailedAccountTracker() {
  const accounts: FailedAccountIdentity[] = [];
  const identity = (
    provider: string,
    resolved: ProviderResolution,
  ): FailedAccountIdentity => {
    const source = resolved.config.credentialSource;
    if (source) {
      return {
        kind: "source",
        sourceId: source.sourceId,
        accountId: source.accountId ?? "__default__",
      };
    }
    return {
      kind: "key",
      provider,
      baseUrl: resolved.config.baseUrl?.replace(/\/+$/, ""),
      apiKey: resolved.config.apiKey,
    };
  };
  return {
    has(provider: string, resolved: ProviderResolution): boolean {
      const candidate = identity(provider, resolved);
      return accounts.some((account) => {
        if (account.kind !== candidate.kind) return false;
        if (account.kind === "source" && candidate.kind === "source") {
          return (
            account.sourceId === candidate.sourceId &&
            account.accountId === candidate.accountId
          );
        }
        if (account.kind === "key" && candidate.kind === "key") {
          return (
            account.provider === candidate.provider &&
            account.baseUrl === candidate.baseUrl &&
            account.apiKey === candidate.apiKey
          );
        }
        return false;
      });
    },
    record(
      provider: string,
      resolved: ProviderResolution,
      error: unknown,
    ): void {
      if (failsWholeAccount(error)) accounts.push(identity(provider, resolved));
    },
  };
}

/** Subset of the provider registry the fallback chain depends on. */
export interface ProviderRegistryLike {
  resolve(
    target: {
      provider: string;
      source?: string;
      baseUrl?: string;
      protocol?: ProviderProtocol;
      requestScoped?: boolean;
    },
    options?: { mode: OperationMode; approvedInstanceOwner?: string },
  ): ProviderResolution;
  withApiKeys(
    resolution: ProviderResolution,
    apiKeys: Record<string, string>,
    providerName: string,
    envApiKeys?: Record<string, string>,
  ): ProviderResolution;
}

export interface PreparedTarget {
  readonly provider: string;
  readonly resolved: ProviderResolution;
  readonly sourceAttempt?: ProviderSourceAttemptContext;
}

export async function withProviderSourceAccounts(
  targets: readonly ResolvedTarget[],
  providerSources: ProviderSourceResolver | undefined,
  signal?: AbortSignal,
): Promise<ResolvedTarget[]> {
  if (!providerSources?.listReadyAccounts) return [...targets];
  const expanded: ResolvedTarget[] = [];
  const accountCache = new Map<string, readonly string[]>();
  for (const target of targets) {
    const preset = target.preset;
    if (!preset?.source || preset.account) {
      expanded.push(target);
      continue;
    }
    let accounts = accountCache.get(preset.source);
    if (!accounts) {
      accounts = await awaitLlmRequest(
        Promise.resolve(
          providerSources.listReadyAccounts(preset.source, signal),
        ),
        signal,
      );
      accountCache.set(preset.source, accounts);
    }
    if (accounts.length > 0) {
      for (const account of new Set(accounts)) {
        expanded.push({ ...target, preset: { ...preset, account } });
      }
    } else {
      expanded.push(target);
    }
  }
  return expanded;
}

export function preparationFailure(
  error: unknown,
  target: ResolvedTarget,
  options: GatewayOptions | undefined,
  hasNext: boolean,
): AiProviderError {
  const failure =
    error instanceof AiProviderError ? error : targetFailure(error, target);
  if (!hasNext || options?.signal?.aborted || !shouldFallback(failure)) {
    throw failure;
  }
  return failure;
}

function rethrowPrepareError(
  error: unknown,
  provider: string,
  target: ResolvedTarget,
): never {
  const failure =
    error instanceof AiProviderError
      ? error
      : new AiProviderError({
          code: "CONFIG_ERROR",
          message: error instanceof Error ? error.message : String(error),
          provider,
          retriable: false,
          cause: error,
        });
  throw targetFailure(failure, target);
}

/**
 * Resolve a target into its provider resolution, applying per-request API keys
 * when supplied. Identical setup used by both fallback paths.
 */
function prepareTarget(
  providerRegistry: ProviderRegistryLike,
  target: ResolvedTarget,
  mode: OperationMode,
  options: GatewayOptions | undefined,
): { provider: string; resolved: ProviderResolution } {
  const provider = targetProvider(target);
  try {
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
  } catch (error) {
    rethrowPrepareError(error, provider, target);
  }
}

function buildSourceProviderResolution(
  providerRegistry: ProviderRegistryLike,
  provider: string,
  mode: OperationMode,
  attempt: ProviderSourceAttemptContext,
): ProviderResolution {
  if (!hasSameOrigin(attempt.baseUrl, attempt.declaredBaseUrl)) {
    throw new AiProviderError({
      code: "CONFIG_ERROR",
      message: `Provider source "${attempt.sourceId}" resolved baseUrl origin outside declared origin.`,
      provider,
      retriable: false,
    });
  }
  const base = providerRegistry.resolve(
    {
      provider,
      source: attempt.sourceId,
      baseUrl: attempt.baseUrl,
      protocol: attempt.protocol,
      requestScoped: true,
    },
    { mode, approvedInstanceOwner: attempt.approvedInstanceOwner },
  );
  const nextConfig: ProviderConfig = {
    ...base.config,
    protocol: attempt.protocol,
    baseUrl: attempt.baseUrl,
    headers: { ...attempt.headers },
    ...(attempt.requestShape ? { requestShape: attempt.requestShape } : {}),
    credentialSource: {
      sourceId: attempt.sourceId,
      ...(attempt.accountId !== undefined
        ? { accountId: attempt.accountId }
        : {}),
      ...(attempt.credentialGeneration !== undefined
        ? { credentialGeneration: attempt.credentialGeneration }
        : {}),
    },
  };
  delete nextConfig.apiKey;
  delete nextConfig.relayable;
  return {
    ...base,
    protocol: attempt.protocol,
    config: nextConfig,
    ...(attempt.approvedInstanceOwner !== undefined
      ? { approvedInstanceOwner: attempt.approvedInstanceOwner }
      : {}),
    envKeyAllowed: false,
  };
}

/**
 * Async target preparation handling both regular API-key targets and
 * `provider.source@1`-backed targets (which run L1-L3/mode/origin checks).
 */
export async function prepareTargetAsync(
  providerRegistry: ProviderRegistryLike,
  providerSources: ProviderSourceResolver | undefined,
  target: ResolvedTarget,
  mode: OperationMode,
  options: GatewayOptions | undefined,
): Promise<PreparedTarget> {
  const sourceId = target.preset?.source;
  if (!sourceId) {
    return prepareTarget(providerRegistry, target, mode, options);
  }
  const provider = targetProvider(target);
  try {
    if (!providerSources) {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        message: `Provider source "${sourceId}" cannot be resolved because provider sources are unavailable.`,
        provider,
        model: targetModel(target),
        retriable: false,
      });
    }
    const attempt = await awaitLlmRequest(
      providerSources.resolve({
        sourceId,
        ...(target.preset?.account ? { accountId: target.preset.account } : {}),
        mode,
        model: targetModel(target),
        ...(target.preset?.baseUrl
          ? { declaredBaseUrl: target.preset.baseUrl }
          : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
      options?.signal,
    );
    if (
      target.preset?.baseUrl &&
      !hasSameOrigin(target.preset.baseUrl, attempt.declaredBaseUrl)
    ) {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        message: `Provider source "${sourceId}" baseUrl origin does not match declared source origin.`,
        provider,
        model: targetModel(target),
        retriable: false,
      });
    }
    const resolved = buildSourceProviderResolution(
      providerRegistry,
      provider,
      mode,
      attempt,
    );
    return { provider, resolved, sourceAttempt: attempt };
  } catch (error) {
    rethrowPrepareError(error, provider, target);
  }
}

/**
 * Attempt a single generation-aware refresh when a source-backed request fails
 * with HTTP 401. Returns the updated resolution + attempt, or `null`.
 */
export async function tryRefreshSourceTarget(args: {
  readonly providerRegistry: ProviderRegistryLike;
  readonly providerSources: ProviderSourceResolver | undefined;
  readonly provider: string;
  readonly mode: OperationMode;
  readonly model: string;
  readonly sourceAttempt: ProviderSourceAttemptContext | undefined;
  readonly error: unknown;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly resolved: ProviderResolution;
  readonly sourceAttempt: ProviderSourceAttemptContext;
} | null> {
  const {
    providerRegistry,
    providerSources,
    provider,
    mode,
    model,
    sourceAttempt,
    error,
    signal,
  } = args;
  if (!sourceAttempt || !providerSources?.refresh) return null;
  const normalized = normalizeError(error, provider);
  if (normalized.statusCode !== 401) return null;
  signal?.throwIfAborted();
  const refreshed = await awaitLlmRequest(
    providerSources.refresh({
      sourceId: sourceAttempt.sourceId,
      mode,
      model,
      ...(sourceAttempt.accountId !== undefined
        ? { accountId: sourceAttempt.accountId }
        : {}),
      ...(sourceAttempt.credentialGeneration !== undefined
        ? { failedGeneration: sourceAttempt.credentialGeneration }
        : {}),
      statusCode: 401,
      ...(signal ? { signal } : {}),
    }),
    signal,
  );
  if (!refreshed) return null;
  return {
    resolved: buildSourceProviderResolution(
      providerRegistry,
      provider,
      mode,
      refreshed,
    ),
    sourceAttempt: refreshed,
  };
}

const SOURCE_ERROR_CODES: Partial<
  Record<ProviderFailureKind, AiProviderError["code"]>
> = {
  rate_limited: "RATE_LIMITED",
  config: "CONFIG_ERROR",
  missing_key: "MISSING_API_KEY",
  refused: "REFUSAL",
};

const RETRIABLE_SOURCE_FAILURE_KINDS = new Set<ProviderFailureKind>([
  "rate_limited",
  "overloaded",
  "server",
  "timeout",
  "unreachable",
]);

/**
 * Allow a provider source to supply protocol/vendor-specific error semantics
 * without baking vendor knowledge into core gateway code.
 */
function applySourceErrorClassification(
  error: unknown,
  provider: string,
  sourceAttempt: ProviderSourceAttemptContext | undefined,
): unknown {
  if (!sourceAttempt?.classifyError) return error;
  const normalized = normalizeError(error, provider);
  const wireContext =
    error instanceof Error ? readSourceWireErrorContext(error) : undefined;
  const classified = sourceAttempt.classifyError({
    statusCode: normalized.statusCode,
    body: wireContext?.body ?? normalized.details,
    message: wireContext?.message ?? normalized.message,
  });
  if (!classified) return error;
  const code = SOURCE_ERROR_CODES[classified.kind] ?? "PROVIDER_ERROR";
  const retriable = RETRIABLE_SOURCE_FAILURE_KINDS.has(classified.kind);
  return new AiProviderError({
    code,
    message: classified.message ?? normalized.message,
    provider,
    ...(normalized.model ? { model: normalized.model } : {}),
    retriable,
    ...(normalized.statusCode !== undefined
      ? { statusCode: normalized.statusCode }
      : {}),
    details: {
      ...normalized.details,
      providerFailureKind: classified.kind,
      ...(classified.retryAfterMs !== undefined
        ? { retryAfterMs: classified.retryAfterMs }
        : {}),
    },
    cause: error,
  });
}

/**
 * Apply the shared per-target failure handling.
 *
 * Applies optional source error classification, records failed accounts,
 * notifies the lifecycle hooks, normalizes the error, and decides — given the
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
  /** The failure of the target tried before this one, when there was one. */
  previous?: AiProviderError | null;
  sourceAttempt?: ProviderSourceAttemptContext;
  failedAccounts?: ReturnType<typeof createFailedAccountTracker>;
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

  const classifiedError = applySourceErrorClassification(
    error,
    provider,
    args.sourceAttempt,
  );
  args.failedAccounts?.record(provider, resolved, classifiedError);

  let failure: unknown = classifiedError;
  try {
    await notifyError(
      resolved.hooks,
      provider,
      resolved.protocol,
      mode,
      targetModel(target),
      classifiedError,
      Date.now() - startTime,
      options?.traceId,
      options,
    );
  } catch (hookAbort) {
    failure = hookAbort;
  }

  const attempted = targetFailure(failure, target);
  // A fallback that was skipped without a request says nothing about why the
  // operation failed. The failure of the target before it stays the error,
  // and the skip is added to it.
  const normalized =
    attempted.details?.fallbackSkipped === true && args.previous
      ? new AiProviderError({
          code: args.previous.code,
          message: `${args.previous.message} Then: ${attempted.message}`,
          provider: args.previous.provider,
          model: args.previous.model,
          retriable: args.previous.retriable,
          statusCode: args.previous.statusCode,
          details: args.previous.details,
          cause: args.previous,
        })
      : attempted;

  if (options?.signal?.aborted || !canFallback || !shouldFallback(normalized)) {
    throw normalized;
  }

  if (options?.requestBudget) {
    try {
      assertLlmRequestBudget(options.requestBudget, {
        signal: options.signal,
        requireAttempt: true,
      });
    } catch (exhausted) {
      throw targetFailure(exhausted, target);
    }
  }

  return normalized;
}

/** Preserve the attempted target even when provider setup fails before I/O. */
function targetFailure(
  error: unknown,
  target: ResolvedTarget,
): AiProviderError {
  const provider = targetProvider(target);
  const model = targetModel(target);
  const failure = normalizeError(error, provider);
  return new AiProviderError({
    code: failure.code,
    message: `[provider: ${provider}, model: ${model}] ${failure.message}`,
    provider,
    model,
    retriable: failure.retriable,
    statusCode: failure.statusCode,
    details: failure.details,
    cause: error,
  });
}
