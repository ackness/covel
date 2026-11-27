import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, Network, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  isDesktopApp,
  setDesktopProxyConfig,
} from "@/lib/desktop-bridge.js";
import type { OutboundNetworkErrorInfo } from "@/lib/outbound-network-error.js";

export function OutboundNetworkErrorBanner({
  info,
  onRetry,
  onOpenProxySettings,
  disabled = false,
}: {
  readonly info: OutboundNetworkErrorInfo;
  readonly onRetry?: () => void;
  readonly onOpenProxySettings?: () => void;
  readonly disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const desktop = isDesktopApp();
  const canSwitchToSystem =
    desktop &&
    info.proxyMode === "direct" &&
    info.systemProxyAvailable === true &&
    typeof onRetry === "function";

  const guidance = (() => {
    if (info.proxyMode === "direct") {
      return info.systemProxyAvailable
        ? t("platform.outboundNetworkDirectSystemHint")
        : t("platform.outboundNetworkDirectHint");
    }
    if (info.proxyMode === "system") {
      return t("platform.outboundNetworkSystemHint");
    }
    if (info.proxyMode === "http" || info.proxyMode === "socks") {
      return t("platform.outboundNetworkManualHint", {
        mode: info.proxyMode.toUpperCase(),
      });
    }
    return t("platform.outboundNetworkGenericHint");
  })();

  const handleSwitchAndRetry = async () => {
    if (switching || disabled) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      await setDesktopProxyConfig({ mode: "system" });
      onRetry?.();
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div
      role="alert"
      className="space-y-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5 font-medium text-destructive">
            <span>{t("platform.outboundNetworkTitle")}</span>
            {info.transportCode && (
              <code className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[11px]">
                {info.transportCode}
              </code>
            )}
          </div>
          <p className="leading-relaxed text-muted-foreground">{guidance}</p>
        </div>
      </div>

      {switchError && (
        <p className="text-[11px] text-destructive">{switchError}</p>
      )}

      {(canSwitchToSystem || onRetry || (desktop && onOpenProxySettings)) && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {canSwitchToSystem && (
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={disabled || switching}
              onClick={() => void handleSwitchAndRetry()}
            >
              {switching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Network className="h-3.5 w-3.5" />
              )}
              {switching
                ? t("platform.outboundNetworkSwitching")
                : t("platform.outboundNetworkSwitchSystemRetry")}
            </Button>
          )}
          {onRetry && (
            <Button
              type="button"
              size="sm"
              variant={canSwitchToSystem ? "outline" : "default"}
              className="h-7 gap-1.5 text-xs"
              disabled={disabled || switching}
              onClick={onRetry}
            >
              <RefreshCw className="h-3 w-3" />
              {t("common.retry", "Retry")}
            </Button>
          )}
          {desktop && onOpenProxySettings && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              disabled={disabled || switching}
              onClick={onOpenProxySettings}
            >
              <Network className="h-3 w-3" />
              {t("platform.outboundNetworkOpenProxySettings")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
