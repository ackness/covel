import type { MiddlewareHandler } from "hono";
import type { BootstrapMemorySystem } from "./memory.js";
import {
  createBootstrapCompactorRunner,
  type CreateBootstrapCompactorRunnerParams,
} from "./compactor.js";

/** Memory and compaction share the adapter selected by request middleware. */
export function requestLlmServices(
  params: Omit<CreateBootstrapCompactorRunnerParams, "llmAdapter">,
  memory: BootstrapMemorySystem | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    if (c.get("requestLlmOverridden")) {
      const llmAdapter = c.get("llmAdapter");
      if (memory)
        c.set(
          "memorySystem",
          memory.forRequest(llmAdapter, c.get("requestMemorySlot")),
        );
      c.set(
        "compactorRunner",
        createBootstrapCompactorRunner({ ...params, llmAdapter }),
      );
    }
    await next();
  };
}
