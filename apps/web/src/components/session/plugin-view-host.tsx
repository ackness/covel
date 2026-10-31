import type { SessionBridgeGrant } from "@covel/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { PluginSurfaceBoundary } from "@/components/error-boundary.js";
import { emitToast } from "@/lib/toast-channel.js";
import { HeaderMenu, MenuItem } from "./game-view/game-view-header.js";
import type { PluginViewEntry } from "./game-view/use-plugin-views.js";
import { PluginPanel } from "./plugin-panel.js";
import { useSessionBridgeActions } from "./use-session-bridge-actions.js";
import {
  pluginViewContent,
  requestedViewGrants,
} from "./plugin-view-consent.js";
import type { PluginViewSession } from "./plugin-view-session-context.js";

export function PluginViewHost({
  entry,
  sessionId,
  onFallback,
  sessionBridgeAllowed = false,
  isCurrent = () => true,
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
  isCurrent?: () => boolean;
  onRevoke?: (capability?: SessionBridgeGrant) => void;
  onRetry?: () => void;
  liveSession?: PluginViewSession;
  executing?: boolean;
  onStop?: () => void;
  awaitingBegin?: boolean;
  onBegin?: () => void;
}) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const retire = useRef<(() => void) | undefined>(undefined);
  const fallback = () => {
    retire.current?.();
    onFallback();
  };
  const readsSession = entry.spec.bridge === "session";
  const failed = useCallback(() => {
    emitToast("error", t("session.viewFailed", { label: entry.label }));
    retire.current?.();
    onFallback("render-error");
  }, [entry.label, onFallback, t]);
  return (
    <section
      className="relative z-1 flex min-h-0 flex-1 flex-col"
      aria-label={entry.label}
    >
      <div
        className="relative z-10 flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2 text-xs"
        data-testid="plugin-view-bar"
        data-covel-host-controls=""
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
          onClick={fallback}
          aria-label={t("session.backToDefaultView")}
        >
          {t("session.backToDefaultView")}
        </Button>
        {readsSession && onRevoke && (
          <HeaderMenu label={t("session.viewPermissions")} active={false}>
            <MenuItem
              icon={ShieldOff}
              label={t("session.revokeViewConsent")}
              onSelect={() => {
                retire.current?.();
                onRevoke();
              }}
            />
            {requestedViewGrants(entry).map((capability) => (
              <MenuItem
                key={capability}
                icon={ShieldOff}
                label={t("session.revokeViewCapability", {
                  capability: t(`session.viewCapability.${capability}`),
                })}
                onSelect={() => {
                  retire.current?.();
                  onRevoke(capability);
                }}
              />
            ))}
          </HeaderMenu>
        )}
      </div>
      <div
        className="relative flex-1 min-h-0 overflow-hidden isolate"
        data-testid="plugin-view-container"
      >
        {(!readsSession || sessionBridgeAllowed) && (
          <PluginSurfaceBoundary
            key={JSON.stringify([
              sessionId,
              entry.pluginId,
              entry.mode,
              pluginViewContent(entry.spec),
            ])}
            surfaceLabel={entry.label}
            onError={failed}
          >
            {readsSession ? (
              <ConsentedView
                key={JSON.stringify([
                  sessionId,
                  pluginViewContent(entry.spec),
                  attempt,
                ])}
                entry={entry}
                sessionId={sessionId}
                isCurrent={isCurrent}
                retire={retire}
                failed={failed}
                openInteraction={fallback}
                onRetry={() => {
                  retire.current?.();
                  setAttempt((value) => value + 1);
                  onRetry?.();
                }}
              />
            ) : (
              <PluginPanel
                themeSessionId={sessionId}
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
                onPageFailure={failed}
                onRetry={onRetry}
              />
            )}
          </PluginSurfaceBoundary>
        )}
      </div>
    </section>
  );
}

function ConsentedView({
  entry,
  sessionId,
  isCurrent,
  retire,
  failed,
  onRetry,
  openInteraction,
}: {
  entry: PluginViewEntry;
  sessionId: string;
  isCurrent: () => boolean;
  retire: { current: (() => void) | undefined };
  failed: () => void;
  onRetry: () => void;
  openInteraction: () => void;
}) {
  const bridge = useSessionBridgeActions(entry, sessionId, isCurrent);
  const { t } = useTranslation();
  retire.current = bridge.retire;
  useEffect(() => {
    if (!bridge.projection) failed();
  }, [bridge.projection, failed]);
  if (!bridge.projection) return null;
  return (
    <>
      {bridge.projection.pending.length > 0 && (
        <Button onClick={openInteraction}>
          {t("session.viewOpenInteraction")}
        </Button>
      )}
      <PluginPanel
        themeSessionId={sessionId}
        pluginId={entry.pluginId}
        panelId={entry.viewId}
        spec={{ ...entry.spec }}
        expanded
        fill
        onRenderError={failed}
        onPageFailure={failed}
        onRetry={onRetry}
        sessionBridge={{
          projection: bridge.projection,
          stream: bridge.stream,
          handlers: bridge.handlers,
          isCurrent: bridge.isCurrent,
        }}
      />
    </>
  );
}
