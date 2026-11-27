import {
  DESKTOP_PROXY_MODES,
  type DesktopProxyMode,
} from "@covel/shared/desktop-config";
import { ApiError } from "@/services/api/request.js";

export interface OutboundNetworkErrorInfo {
  readonly transportCode?: string;
  readonly proxyMode?: DesktopProxyMode;
  readonly systemProxyAvailable?: boolean;
}

export function parseOutboundNetworkError(
  error: unknown,
): OutboundNetworkErrorInfo | null {
  if (!(error instanceof ApiError) || error.code !== "outbound_network_error") {
    return null;
  }
  const details =
    error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : {};
  const transportCode =
    typeof details.transportCode === "string" && details.transportCode.trim()
      ? details.transportCode.trim()
      : undefined;
  const proxyMode = DESKTOP_PROXY_MODES.find(
    (mode) => mode === details.proxyMode,
  );
  const systemProxyAvailable =
    typeof details.systemProxyAvailable === "boolean"
      ? details.systemProxyAvailable
      : undefined;

  return {
    ...(transportCode ? { transportCode } : {}),
    ...(proxyMode ? { proxyMode } : {}),
    ...(systemProxyAvailable !== undefined ? { systemProxyAvailable } : {}),
  };
}
