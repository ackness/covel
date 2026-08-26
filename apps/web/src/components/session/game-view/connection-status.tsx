import { useTranslation } from "react-i18next";
import { Loader2, WifiOff } from "lucide-react";
import { useConnectionState } from "@/stores/connection-store.js";

/**
 * Non-blocking SSE connection indicator. Stays out of the way while the
 * stream is healthy (renders nothing when "connected"), and surfaces a small
 * aria-live chip while connecting / reconnecting / closed so the player knows
 * real-time updates are temporarily paused.
 */
export function ConnectionStatus() {
  const { t } = useTranslation();
  const state = useConnectionState();

  if (state === "connected") return null;

  const isReconnecting = state === "reconnecting";
  const isConnecting = state === "connecting";
  const label = isReconnecting
    ? t("session.connectionReconnecting", "Reconnecting…")
    : isConnecting
      ? t("session.connectionConnecting", "Connecting…")
      : t("session.connectionLost", "Connection lost");

  return (
    <span
      className="ui-chip ml-1 inline-flex items-center gap-1 text-[10px] border-transparent bg-[color-mix(in_oklab,var(--accent-warning)_14%,transparent)] text-(--accent-warning)"
      role="status"
      aria-live="polite"
    >
      {isConnecting || isReconnecting ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <WifiOff className="h-3 w-3" />
      )}
      {label}
    </span>
  );
}
