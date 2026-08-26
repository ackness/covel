export const SYSTEM_PROXY_IPC_VERSION = 1 as const;

export interface SystemProxyResolveRequest {
  readonly type: "covel:system-proxy:resolve";
  readonly version: typeof SYSTEM_PROXY_IPC_VERSION;
  readonly requestId: string;
  readonly url: string;
}

export interface SystemProxyResolveResponse {
  readonly type: "covel:system-proxy:resolved";
  readonly version: typeof SYSTEM_PROXY_IPC_VERSION;
  readonly requestId: string;
  readonly result?: string;
  readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function isSystemProxyResolveRequest(
  value: unknown,
): value is SystemProxyResolveRequest {
  if (!isRecord(value)) return false;
  if (
    value.type !== "covel:system-proxy:resolve" ||
    value.version !== SYSTEM_PROXY_IPC_VERSION ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    value.requestId.length > 128 ||
    typeof value.url !== "string" ||
    value.url.length === 0 ||
    value.url.length > 8_192
  ) {
    return false;
  }
  try {
    return ["http:", "https:"].includes(new URL(value.url).protocol);
  } catch {
    return false;
  }
}

export function isSystemProxyResolveResponse(
  value: unknown,
): value is SystemProxyResolveResponse {
  if (!isRecord(value)) return false;
  if (
    value.type !== "covel:system-proxy:resolved" ||
    value.version !== SYSTEM_PROXY_IPC_VERSION ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    value.requestId.length > 128
  ) {
    return false;
  }
  const validResult =
    typeof value.result === "string" && value.result.length <= 65_536;
  const validError =
    typeof value.error === "string" &&
    value.error.length > 0 &&
    value.error.length <= 1_024;
  return validResult !== validError;
}
