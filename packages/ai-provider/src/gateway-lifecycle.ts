import { AiProviderError, OutboundFetchError } from "./errors.js";
import {
  awaitLlmRequest,
  createLlmRequestScope,
  LLMRequestBudgetError,
  type LLMRequestBudget,
} from "@covel/shared";
import type {
  OperationMode,
  ProviderLifecycleHook,
  ProviderProtocol,
  ResolvedTarget,
  UsageSummary,
} from "./types.js";

export function targetProvider(target: ResolvedTarget): string {
  return target.preset?.provider ?? target.profile.provider;
}

export function targetModel(target: ResolvedTarget): string {
  return target.preset?.model ?? target.profile.model;
}

/** Telemetry observers are isolated from provider routing and call results. */
export function notifyTargetAttempt(
  observer: ((target: { provider: string; model: string }) => void) | undefined,
  target: ResolvedTarget,
): void {
  try {
    observer?.({
      provider: targetProvider(target),
      model: targetModel(target),
    });
  } catch {
    // Observability must never alter the provider fallback chain.
  }
}

export function shouldFallback(error: AiProviderError): boolean {
  if (error.code === "REFUSAL" || error.code === "REQUEST_BUDGET_EXCEEDED") {
    return false;
  }
  // Rate limits belong to the attempted provider, so a backup can still work.
  if (error.statusCode === 429) return true;
  // Other client errors retain their explicit failure path.
  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    return false;
  }
  return error.code === "RATE_LIMITED" || error.code === "PROVIDER_ERROR";
}

export function normalizeError(
  error: unknown,
  provider: string,
): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (error instanceof LLMRequestBudgetError) {
    return new AiProviderError({
      code: "REQUEST_BUDGET_EXCEEDED",
      message: error.message,
      provider,
      retriable: false,
      cause: error,
    });
  }
  if (error instanceof RangeError) {
    return new AiProviderError({
      code: "CONFIG_ERROR",
      message: error.message,
      provider,
      retriable: false,
      cause: error,
    });
  }

  return new AiProviderError({
    code: "PROVIDER_ERROR",
    message: error instanceof Error ? error.message : "Unknown provider error.",
    provider,
    retriable: isTransientTransportError(error),
    cause: error,
  });
}

const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Fetch and Undici retain transport failures in their cause chain. */
function isTransientTransportError(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; cause instanceof Error && depth < 8; depth++) {
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_TRANSPORT_CODES.has(code)) {
      return true;
    }
    // Generic abort/timeout names can represent the caller's whole deadline.
    // Attempt-level timeout retries belong to the owner of that signal;
    // transport timeouts are identified by the explicit codes above.
    if (cause instanceof OutboundFetchError) return true;
    // Fallback for a plugin wire that calls the platform `fetch` itself:
    // Undici's "no response" error has no class or code, only this text.
    if (cause instanceof TypeError && cause.message === "fetch failed") {
      return true;
    }
    cause = cause.cause;
  }
  return false;
}

export async function notifyStart(
  hooks: ProviderLifecycleHook[],
  provider: string,
  protocol: ProviderProtocol,
  mode: OperationMode,
  model: string,
  traceId?: string,
  options?: LifecycleOptions,
): Promise<void> {
  await notifyHooks(
    hooks,
    "onRequestStart",
    (hook) =>
      hook.onRequestStart?.({ provider, protocol, mode, model, traceId }),
    options,
  );
}

export async function notifySuccess(
  hooks: ProviderLifecycleHook[],
  provider: string,
  protocol: ProviderProtocol,
  mode: OperationMode,
  model: string,
  usage: UsageSummary | null,
  durationMs: number,
  traceId?: string,
  options?: LifecycleOptions,
): Promise<void> {
  await notifyHooks(
    hooks,
    "onRequestSuccess",
    (hook) =>
      hook.onRequestSuccess?.({
        provider,
        protocol,
        mode,
        model,
        usage,
        durationMs,
        traceId,
      }),
    options,
  );
}

export async function notifyError(
  hooks: ProviderLifecycleHook[],
  provider: string,
  protocol: ProviderProtocol,
  mode: OperationMode,
  model: string,
  error: unknown,
  durationMs: number,
  traceId?: string,
  options?: LifecycleOptions,
): Promise<void> {
  await notifyHooks(
    hooks,
    "onRequestError",
    (hook) =>
      hook.onRequestError?.({
        provider,
        protocol,
        mode,
        model,
        error,
        durationMs,
        traceId,
      }),
    options,
  );
}

interface LifecycleOptions {
  signal?: AbortSignal;
  requestBudget?: LLMRequestBudget;
}

/** One phase gets at most one second of observer time, regardless of hook count. */
async function notifyHooks(
  hooks: ProviderLifecycleHook[],
  name: keyof ProviderLifecycleHook,
  invoke: (hook: ProviderLifecycleHook) => void | Promise<void>,
  options?: LifecycleOptions,
): Promise<void> {
  const scope = options?.requestBudget
    ? createLlmRequestScope({
        budget: options.requestBudget,
        signal: options.signal,
      })
    : undefined;
  const requestSignal = scope?.signal ?? options?.signal;
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error("Lifecycle hook deadline exceeded")),
    1_000,
  );
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, timeout.signal])
    : timeout.signal;
  try {
    requestSignal?.throwIfAborted();
    for (const hook of hooks) {
      try {
        signal.throwIfAborted();
        await awaitLlmRequest(
          Promise.resolve().then(() => invoke(hook)),
          signal,
        );
      } catch (error) {
        requestSignal?.throwIfAborted();
        console.warn(
          `[ai-provider] Hook ${name} failed:`,
          error instanceof Error ? error.message : error,
        );
        if (timeout.signal.aborted) break;
      }
    }
  } finally {
    clearTimeout(timer);
    scope?.dispose();
  }
}
