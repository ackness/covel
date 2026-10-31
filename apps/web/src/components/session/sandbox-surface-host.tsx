import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";
import { PluginViewHost } from "./plugin-view-host.js";
import type { PluginViewEntry } from "./game-view/use-plugin-views.js";

/** A bounded input region; iframe positioning never escapes this container. */
export function SandboxSurfaceHost(
  props: ComponentProps<typeof PluginViewHost>,
) {
  return (
    <div
      className="relative isolate flex h-64 min-h-40 max-h-[45vh] shrink-0 flex-col overflow-hidden"
      data-testid="sandbox-composer"
    >
      <PluginViewHost {...props} />
    </div>
  );
}

/** Host-owned chrome stays above the clipped story and input regions, even in immersive mode. */
export function SandboxSurfaceControls({
  mainLabel,
  composers,
  composerMode,
  onComposerChange,
  onReturn,
  onStop,
  onRecovery,
  executing,
  notices,
}: {
  mainLabel: string;
  composers: readonly PluginViewEntry[];
  composerMode: string;
  onComposerChange: (mode: string) => void;
  onReturn: () => void;
  onStop: () => void;
  onRecovery: () => void;
  executing: boolean;
  notices: readonly {
    region: string;
    label: string;
    onRetry: () => void;
    onRevoke: () => void;
  }[];
}) {
  const { t } = useTranslation();
  return (
    <div
      data-covel-host-controls=""
      data-testid="sandbox-surface-controls"
      className="relative flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2 text-xs"
      style={{ zIndex: 30 }}
    >
      <span>
        {t("session.surfaceMain")}: {mainLabel}
      </span>
      <label className="flex min-w-0 items-center gap-2">
        {t("session.surfaceComposer")}
        <select
          className="min-h-10 min-w-0 max-w-40 rounded border bg-background px-2"
          value={composerMode}
          onChange={(event) => onComposerChange(event.target.value)}
        >
          <option value="">{t("session.surfaceDefault")}</option>
          {composers.map((entry) => (
            <option key={entry.mode} value={entry.mode}>
              {entry.label} · {entry.pluginName}
            </option>
          ))}
        </select>
      </label>
      <Button
        size="sm"
        className="min-h-10"
        variant="outline"
        onClick={onReturn}
      >
        {t("session.surfaceReturn")}
      </Button>
      {executing && (
        <Button
          size="sm"
          className="min-h-10"
          variant="outline"
          onClick={onStop}
        >
          {t("session.surfaceStop")}
        </Button>
      )}
      <Button
        size="sm"
        className="min-h-10"
        variant="ghost"
        onClick={onRecovery}
      >
        {t("session.surfaceRecovery")}
      </Button>
      {notices.map((notice) => (
        <div
          role="status"
          key={notice.region}
          className="flex w-full flex-wrap items-center gap-2"
        >
          <span>{t("session.surfaceFailed", { label: notice.label })}</span>
          <Button size="sm" variant="outline" onClick={notice.onRetry}>
            {t("session.pageRetry")}
          </Button>
          <Button size="sm" variant="ghost" onClick={notice.onRevoke}>
            {t("session.revokeViewConsent")}
          </Button>
        </div>
      ))}
    </div>
  );
}
