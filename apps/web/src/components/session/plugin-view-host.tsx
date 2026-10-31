import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { PluginSurfaceBoundary } from "@/components/error-boundary.js";
import { emitToast } from "@/lib/toast-channel.js";
import { HeaderMenu, MenuItem } from "./game-view/game-view-header.js";
import type { PluginViewEntry } from "./game-view/use-plugin-views.js";
import { PluginPanel } from "./plugin-panel.js";
import { useSessionBridge } from "./use-session-bridge.js";
import type { PluginViewSession } from "./plugin-view-session-context.js";

export function PluginViewHost({
  entry,
  sessionId,
  onFallback,
  sessionBridgeAllowed = false,
  onRevoke,
  onRetry,
  liveSession,
  executing,
  onStop,
  awaitingBegin,
  onBegin,
}: {
  entry: PluginViewEntry;
  sessionId: string;
  onFallback: (reason?: "render-error") => void;
  /** Granted for this exact plugin + content hash by the host consent gate. */
  sessionBridgeAllowed?: boolean;
  onRevoke?: () => void;
  onRetry?: () => void;
  liveSession?: PluginViewSession;
  executing?: boolean;
  onStop?: () => void;
  awaitingBegin?: boolean;
  onBegin?: () => void;
}) {
  const { t } = useTranslation();
  const bridge = useSessionBridge(sessionId);
  const readsSession = entry.spec.bridge === "session";
  const failed = useCallback(() => {
    emitToast("error", t("session.viewFailed", { label: entry.label }));
    onFallback("render-error");
  }, [entry.label, onFallback, t]);
  return (
    <section
      className="relative z-1 flex min-h-0 flex-1 flex-col"
      aria-label={entry.label}
    >
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs"
        data-testid="plugin-view-bar"
      >
        <strong>{entry.label}</strong>
        <span className="hidden text-muted-foreground sm:inline">
          {entry.pluginName}
        </span>
        {readsSession && <span>{t("session.viewReadsStory")}</span>}
        {awaitingBegin && onBegin && (
          <Button size="sm" onClick={onBegin}>
            {t("session.beginAdventure")}
          </Button>
        )}
        {executing && onStop && (
          <Button variant="outline" size="sm" onClick={onStop}>
            {t("session.abortTurn")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => onFallback()}
          aria-label={t("session.backToDefaultView")}
        >
          {t("session.backToDefaultView")}
        </Button>
        {readsSession && onRevoke && (
          <HeaderMenu label={t("session.viewPermissions")} active={false}>
            <MenuItem
              icon={ShieldOff}
              label={t("session.revokeViewConsent")}
              onSelect={onRevoke}
            />
          </HeaderMenu>
        )}
      </div>
      <div
        className="relative flex-1 min-h-0 overflow-hidden isolate"
        data-testid="plugin-view-container"
      >
        {(!readsSession || sessionBridgeAllowed) && (
          <PluginSurfaceBoundary
            key={entry.mode}
            surfaceLabel={entry.label}
            onError={failed}
          >
            <PluginPanel
              pluginId={entry.pluginId}
              panelId={entry.viewId}
              spec={{ ...entry.spec }}
              expanded
              fill
              liveSession={
                !entry.spec.webview && liveSession?.sessionId === sessionId
                  ? liveSession
                  : undefined
              }
              onRenderError={failed}
              onRetry={onRetry}
              sessionBridge={
                readsSession && sessionBridgeAllowed && bridge.projection
                  ? { projection: bridge.projection, stream: bridge.stream }
                  : undefined
              }
            />
          </PluginSurfaceBoundary>
        )}
      </div>
    </section>
  );
}
