import {
  OutboundFetchError,
  SsrfPolicyError,
  getOutboundProxyStatus,
} from "@covel/ai-provider";
import type { ApiErrorResponse } from "@covel/shared";
import { errorBody } from "../api-error.js";

const SAFE_TRANSPORT_CODE_RE = /^[A-Z0-9_]{2,48}$/;

function sanitizeTransportCode(code: unknown): string | undefined {
  return typeof code === "string" && SAFE_TRANSPORT_CODE_RE.test(code)
    ? code
    : undefined;
}

function isSystemProxyError(error: Error): boolean {
  return (
    error.message.startsWith("System proxy resolution") ||
    error.message.startsWith("Desktop proxy IPC")
  );
}

/**
 * Map a platform outbound transport/proxy failure into a safe, actionable
 * 502/504 API error so production builds do not swallow network/proxy errors
 * as an opaque 500 "Internal server error". Never includes proxy URLs,
 * credentials, request headers, or stack traces.
 */
export function toOutboundNetworkErrorResponse(error: unknown): {
  readonly status: 502 | 504;
  readonly body: ApiErrorResponse;
} | null {
  let cursor: unknown = error;
  let matched:
    | {
        readonly status: 502 | 504;
        readonly transportCode?: string;
        readonly message: string;
      }
    | undefined;

  for (let depth = 0; cursor instanceof Error && depth < 6; depth++) {
    if (cursor instanceof SsrfPolicyError) return null;
    if (cursor instanceof OutboundFetchError) {
      const transportCode = sanitizeTransportCode(cursor.code);
      matched = {
        status: transportCode === "ETIMEDOUT" ? 504 : 502,
        ...(transportCode ? { transportCode } : {}),
        message: transportCode
          ? `Upstream network request failed (${transportCode})`
          : "Upstream network request failed",
      };
      break;
    }
    if (cursor.name === "TimeoutError") {
      matched = {
        status: 504,
        transportCode: "ETIMEDOUT",
        message: "Upstream network request timed out (ETIMEDOUT)",
      };
      break;
    }
    if (isSystemProxyError(cursor)) {
      matched = {
        status: 502,
        transportCode: "SYSTEM_PROXY_ERROR",
        message: "System proxy resolution failed (SYSTEM_PROXY_ERROR)",
      };
      break;
    }
    cursor = cursor.cause;
  }

  if (!matched) return null;

  const proxyStatus = getOutboundProxyStatus();
  return {
    status: matched.status,
    body: errorBody(matched.message, {
      code: "outbound_network_error",
      details: {
        ...(matched.transportCode
          ? { transportCode: matched.transportCode }
          : {}),
        proxyMode: proxyStatus.mode,
        proxyEffective: proxyStatus.effective,
        systemProxyAvailable: proxyStatus.systemAvailable,
      },
    }),
  };
}
