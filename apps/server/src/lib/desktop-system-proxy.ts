import { randomUUID } from "node:crypto";
import {
  SYSTEM_PROXY_IPC_VERSION,
  isSystemProxyResolveResponse,
  type SystemProxyResolveRequest,
} from "@covel/shared";
import type { SystemProxyResolver } from "@covel/ai-provider";

const DEFAULT_TIMEOUT_MS = 35_000;
const MAX_PENDING_REQUESTS = 64;

export interface SystemProxyIpcClient {
  readonly connected: () => boolean;
  readonly send: (
    request: SystemProxyResolveRequest,
    callback: (error: Error | null) => void,
  ) => void;
  readonly subscribe: (
    onMessage: (message: unknown) => void,
    onDisconnect: () => void,
  ) => () => void;
}

interface PendingRequest {
  readonly resolve: (result: string) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly removeAbortListener: () => void;
}

function abortError(): Error {
  return Object.assign(new Error("System proxy resolution was aborted."), {
    name: "AbortError",
  });
}

export function createSystemProxyIpcResolver(
  client: SystemProxyIpcClient,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): { readonly resolve: SystemProxyResolver; readonly dispose: () => void } {
  const pending = new Map<string, PendingRequest>();

  const rejectRequest = (requestId: string, error: Error): void => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timeout);
    request.removeAbortListener();
    request.reject(error);
  };

  const unsubscribe = client.subscribe(
    (message) => {
      if (!isSystemProxyResolveResponse(message)) return;
      const request = pending.get(message.requestId);
      if (!request) return;
      if (message.error) {
        rejectRequest(
          message.requestId,
          new Error(`System proxy resolution failed: ${message.error}`),
        );
        return;
      }
      pending.delete(message.requestId);
      clearTimeout(request.timeout);
      request.removeAbortListener();
      request.resolve(message.result!);
    },
    () => {
      for (const requestId of [...pending.keys()]) {
        rejectRequest(requestId, new Error("Desktop proxy IPC disconnected."));
      }
    },
  );

  const resolve: SystemProxyResolver = (targetUrl, signal) => {
    if (!client.connected()) {
      return Promise.reject(new Error("Desktop proxy IPC is unavailable."));
    }
    if (pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new Error("Too many pending system proxy resolution requests."),
      );
    }
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<string>((resolveRequest, rejectRequestPromise) => {
      const requestId = randomUUID();
      const onAbort = (): void => rejectRequest(requestId, abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        rejectRequest(
          requestId,
          new Error(`System proxy resolution timed out after ${timeoutMs}ms.`),
        );
      }, timeoutMs);
      pending.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequestPromise,
        timeout,
        removeAbortListener: () =>
          signal?.removeEventListener("abort", onAbort),
      });

      try {
        client.send(
          {
            type: "covel:system-proxy:resolve",
            version: SYSTEM_PROXY_IPC_VERSION,
            requestId,
            url: targetUrl,
          },
          (error) => {
            if (error) rejectRequest(requestId, error);
          },
        );
      } catch (error) {
        rejectRequest(
          requestId,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  };

  return {
    resolve,
    dispose: () => {
      unsubscribe();
      for (const requestId of [...pending.keys()]) {
        rejectRequest(requestId, new Error("System proxy resolver disposed."));
      }
    },
  };
}

let processResolver:
  ReturnType<typeof createSystemProxyIpcResolver> | undefined;

export function hasDesktopSystemProxyIpc(
  env: NodeJS.ProcessEnv,
  send: unknown,
): boolean {
  return (
    env.COVEL_DESKTOP_SYSTEM_PROXY_IPC === "1" && typeof send === "function"
  );
}

/** Return the resolver only for a sidecar explicitly launched by Electron. */
export function getDesktopSystemProxyResolver():
  SystemProxyResolver | undefined {
  if (!hasDesktopSystemProxyIpc(process.env, process.send)) return undefined;
  processResolver ??= createSystemProxyIpcResolver({
    connected: () => process.connected,
    send: (request, callback) => {
      process.send!(request, callback);
    },
    subscribe: (onMessage, onDisconnect) => {
      process.on("message", onMessage);
      process.on("disconnect", onDisconnect);
      return () => {
        process.off("message", onMessage);
        process.off("disconnect", onDisconnect);
      };
    },
  });
  return processResolver.resolve;
}
