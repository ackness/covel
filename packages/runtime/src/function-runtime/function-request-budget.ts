import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMRequestBudget } from "@covel/shared";

/**
 * Host-owned context, never an author-supplied gateway input.
 *
 * `withStalledCallRetry` sets it around one deadline-bound model call; the
 * plugin gateway facade reads it when it builds the request. The budget has
 * to cross the author-facing `PluginRuntimeGateway` wrappers (trace, defaults,
 * prompt cache key), whose public signature has no place for it.
 *
 * Absent is a valid state, not a lost scope: a gateway call without a runtime
 * deadline (service, hook, RPC, presentation without retry, tests) uses the
 * gateway's own default budget, and the runtime's abort signal still bounds
 * a deadline-bound call either way.
 */
export const functionRequestBudget = new AsyncLocalStorage<LLMRequestBudget>();
