/**
 * utils-trace — wrap `PluginRuntimeUtils` so each `fetchWithRetry` provider call
 * emits `utils.fetch.calling` / `utils.fetch.responded` / `utils.fetch.failed`
 * trace events through the turn-scoped `TurnEmitter`.
 *
 * This is a follow-up: image plugins (dashscope-image-gen,
 * openai-image-gen) and any plugin that owns its wire format call provider
 * endpoints via `ctx.utils.fetchWithRetry` rather than the gateway facade, so
 * those calls were invisible in the trace timeline. Tracing the generic utils
 * layer (not a hardcoded 'image' path) keeps the framework↔plugin isolation
 * rule intact. `validateBaseUrl` is a pure local check and passes through.
 *
 * PII: only the request HOST + method + result status are emitted — never the
 * full URL, query string, headers, or API keys.
 */

import type { PluginRuntimeUtils } from "@covel/plugin-loader";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import type { GatewayTraceContext } from "./gateway-trace.js";
import { summarizeTraceError } from "./trace-error.js";

/** Extract just the host (no path/query/credentials) for a PII-safe label. */
function hostOf(input: string | URL): string {
  try {
    return new URL(typeof input === "string" ? input : input.href).host;
  } catch {
    return "(invalid-url)";
  }
}

/**
 * Return a facade over `utils` that traces `fetchWithRetry` calls via `emitter`.
 * Behaviourally identical to the wrapped utils (same inputs, same Response, same
 * thrown errors). The wrapper sits OUTSIDE fetchWithRetry's internal retry loop,
 * so it observes the final outcome, not per-attempt retries.
 */
export function withUtilsTrace(
  utils: PluginRuntimeUtils,
  emitter: TurnEmitter,
  ctx: GatewayTraceContext,
): PluginRuntimeUtils {
  return {
    validateBaseUrl: (url) => utils.validateBaseUrl(url),
    async fetchWithRetry(input, init) {
      const host = hostOf(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const start = Date.now();
      await emitter.emit("utils.fetch.calling", { ...ctx, host, method });
      try {
        const response = await utils.fetchWithRetry(input, init);
        await emitter.emit("utils.fetch.responded", {
          ...ctx,
          host,
          method,
          status: response.status,
          ok: response.ok,
          durationMs: Date.now() - start,
        });
        return response;
      } catch (err) {
        await emitter.emit("utils.fetch.failed", {
          ...ctx,
          host,
          method,
          error: summarizeTraceError(err),
          durationMs: Date.now() - start,
        });
        throw err;
      }
    },
  };
}
