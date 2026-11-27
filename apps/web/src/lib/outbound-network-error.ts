import { ApiError } from "@/services/api/request.js";

export type OutboundProxyModeSummary = "direct" | "system" | "http" | "socks";

export interface OutboundNetworkErrorInfo {
  readonly transportCode?: string;
  readonly proxyMode?: OutboundProxyModeSummary;
  readonly proxyEffective?: "direct" | "proxy" | "system";
  readonly systemProxyAvailable?: boolean;
  readonly fallbackMessage: string;
}

const PROXY_MODES = new Set<OutboundProxyModeSummary>([
  "direct",
  "system",
  "http",
  "socks",
]);

const EFFECTIVE_MODES = new Set<"direct" | "proxy" | "system">([
  "direct",
  "proxy",
  "system",
]);

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
  const proxyMode =
    typeof details.proxyMode === "string" &&
    PROXY_MODES.has(details.proxyMode as OutboundProxyModeSummary)
      ? (details.proxyMode as OutboundProxyModeSummary)
      : undefined;
  const proxyEffective =
    typeof details.proxyEffective === "string" &&
    EFFECTIVE_MODES.has(details.proxyEffective as "direct" | "proxy" | "system")
      ? (details.proxyEffective as "direct" | "proxy" | "system")
      : undefined;
  const systemProxyAvailable =
    typeof details.systemProxyAvailable === "boolean"
      ? details.systemProxyAvailable
      : undefined;

  return {
    ...(transportCode ? { transportCode } : {}),
    ...(proxyMode ? { proxyMode } : {}),
    ...(proxyEffective ? { proxyEffective } : {}),
    ...(systemProxyAvailable !== undefined ? { systemProxyAvailable } : {}),
    fallbackMessage: error.response?.error ?? error.message,
  };
}
