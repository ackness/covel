import type { ProviderLifecycleHook, UsageSummary } from "../types.js";

/**
 * Create a Langfuse lifecycle hook for AI provider tracing.
 *
 * Requires the `langfuse` package to be installed (optional dependency).
 * Returns null if Langfuse env vars are not configured.
 *
 * Expected env vars:
 * - LANGFUSE_PUBLIC_KEY
 * - LANGFUSE_SECRET_KEY
 * - LANGFUSE_BASE_URL (optional, defaults to Langfuse cloud)
 */
export async function createLangfuseHook(): Promise<ProviderLifecycleHook | null> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (!publicKey || !secretKey) return null;

  let Langfuse: any;
  try {
    const mod = await import("langfuse");
    Langfuse = mod.Langfuse;
  } catch {
    return null;
  }

  const langfuse = new Langfuse({
    publicKey,
    secretKey,
    ...(process.env.LANGFUSE_BASE_URL
      ? { baseUrl: process.env.LANGFUSE_BASE_URL }
      : {}),
  });

  const activeSpans = new Map<string, any>();

  return {
    onRequestStart(event) {
      const spanKey = `${event.traceId ?? "anon"}-${event.provider}-${event.model}`;
      const trace = langfuse.trace({
        id: event.traceId,
        name: `ai.${event.mode}`,
        metadata: {
          provider: event.provider,
          protocol: event.protocol,
          model: event.model,
        },
      });

      const span = trace.span({
        name: `${event.provider}/${event.model}`,
        metadata: {
          mode: event.mode,
          protocol: event.protocol,
        },
      });

      activeSpans.set(spanKey, span);
    },

    onRequestSuccess(event) {
      const spanKey = `${event.traceId ?? "anon"}-${event.provider}-${event.model}`;
      const span = activeSpans.get(spanKey);
      if (!span) return;

      span.end({
        output: { usage: event.usage },
        metadata: {
          durationMs: event.durationMs,
          ...(event.usage
            ? {
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
              }
            : {}),
        },
      });

      activeSpans.delete(spanKey);
    },

    onRequestError(event) {
      const spanKey = `${event.traceId ?? "anon"}-${event.provider}-${event.model}`;
      const span = activeSpans.get(spanKey);
      if (!span) return;

      span.end({
        level: "ERROR",
        statusMessage:
          event.error instanceof Error
            ? event.error.message
            : "Unknown error",
        metadata: { durationMs: event.durationMs },
      });

      activeSpans.delete(spanKey);
    },
  };
}
