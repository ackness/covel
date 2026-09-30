import { AsyncLocalStorage } from "node:async_hooks";
import type { GatewayOptions } from "@covel/ai-provider";

// Async tasks inherit their originating request configuration. No global key
// map or session storage retains the browser's credentials.
const requestLlmContext = new AsyncLocalStorage<GatewayOptions | undefined>();

export function getRequestLlmOptions(): GatewayOptions | undefined {
  return requestLlmContext.getStore();
}

export function withRequestLlmOptions<T>(
  options: GatewayOptions | undefined,
  task: () => T,
): T {
  return requestLlmContext.run(options, task);
}
