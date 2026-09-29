import type { MiddlewareHandler } from "hono";
import {
  createBootstrapCompactorRunner,
  type CreateBootstrapCompactorRunnerParams,
} from "./compactor.js";

/** Compaction uses the adapter selected by request middleware. */
export function requestLlmServices(
  params: Omit<CreateBootstrapCompactorRunnerParams, "llmAdapter">,
): MiddlewareHandler {
  return async (c, next) => {
    if (c.get("requestLlmOverridden")) {
      const llmAdapter = c.get("llmAdapter");
      c.set(
        "compactorRunner",
        createBootstrapCompactorRunner({ ...params, llmAdapter }),
      );
    }
    await next();
  };
}
