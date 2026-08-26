import {
  SYSTEM_PROXY_IPC_VERSION,
  isSystemProxyResolveRequest,
  type SystemProxyResolveResponse,
} from "@covel/shared";

/** Resolve a validated sidecar request without exposing Electron to arbitrary IPC. */
export async function resolveSystemProxyRequest(
  message: unknown,
  resolveProxy: (url: string) => Promise<string>,
): Promise<SystemProxyResolveResponse | undefined> {
  if (!isSystemProxyResolveRequest(message)) return undefined;
  try {
    return {
      type: "covel:system-proxy:resolved",
      version: SYSTEM_PROXY_IPC_VERSION,
      requestId: message.requestId,
      result: await resolveProxy(message.url),
    };
  } catch (error) {
    return {
      type: "covel:system-proxy:resolved",
      version: SYSTEM_PROXY_IPC_VERSION,
      requestId: message.requestId,
      error: (error instanceof Error ? error.message : String(error)).slice(
        0,
        1_024,
      ),
    };
  }
}
