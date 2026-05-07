import type { ProviderLifecycleHook, UsageSummary } from "../types.js";
import { readEnvString } from "@covel/shared";

/** Minimal interface for Langfuse span objects. */
interface LangfuseSpan {
  end(opts?: Record<string, unknown>): void;
}

/** Minimal interface for Langfuse trace objects. */
interface LangfuseTrace {
  span(opts: Record<string, unknown>): LangfuseSpan;
}

/** Minimal interface for the Langfuse client. */
interface LangfuseClient {
  trace(opts: Record<string, unknown>): LangfuseTrace;
}

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
  const publicKey = readEnvString("LANGFUSE_PUBLIC_KEY");
  const secretKey = readEnvString("LANGFUSE_SECRET_KEY");
  const baseUrl = readEnvString("LANGFUSE_BASE_URL");

  if (!publicKey || !secretKey) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let LangfuseCtor:
    | (new (opts: Record<string, unknown>) => LangfuseClient)
    | undefined;
  try {
    const mod = await import("langfuse");
    LangfuseCtor = mod.Langfuse as typeof LangfuseCtor;
  } catch {
    return null;
  }

  if (!LangfuseCtor) return null;

  const langfuse: LangfuseClient = new LangfuseCtor({
    publicKey,
    secretKey,
    ...(baseUrl ? { baseUrl } : {}),
  });

  const activeSpans = new Map<string, LangfuseSpan>();

  return {
    onRequestStart(event) {
      const spanKey = `${event.traceId ?? "anon"}-${event.provider}-${event.model}`;
      try {
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
      } catch (err) {
        console.warn(
          "[ai-provider] Langfuse trace creation failed:",
          err instanceof Error ? err.message : err,
        );
      }
    },

    onRequestSuccess(event) {
      const spanKey = `${event.traceId ?? "anon"}-${event.provider}-${event.model}`;
      const span = activeSpans.get(spanKey);
      if (!span) return;

      try {
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
      } catch (err) {
        console.warn(
          "[ai-provider] Langfuse span.end failed:",
          err instanceof Error ? err.message : err,
        );
      }

      activeSpans.delete(spanKey);
    },

    onRequestError(event) {
      const spanKey = `${event.traceId ?? "anon"}-${event.provider}-${event.model}`;
      const span = activeSpans.get(spanKey);
      if (!span) return;

      try {
        span.end({
          level: "ERROR",
          statusMessage:
            event.error instanceof Error
              ? event.error.message
              : "Unknown error",
          metadata: { durationMs: event.durationMs },
        });
      } catch (err) {
        console.warn(
          "[ai-provider] Langfuse span.end (error) failed:",
          err instanceof Error ? err.message : err,
        );
      }

      activeSpans.delete(spanKey);
    },
  };
}
