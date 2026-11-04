import { usePluginThemeSessionState } from "@/theme-system/use-plugin-theme.js";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveI18nText } from "@covel/shared";
import type { PluginThemeSession } from "@/theme-system/plugin-themes.js";
import { Button } from "@/components/ui/button.js";

/**
 * This game's theme choice, for the session menu. It appears only when a
 * plugin offers themes (or one is still selected, so the default look can be
 * restored).
 */
export function SessionThemeSettings({
  source,
  onReload,
}: {
  source?: PluginThemeSession;
  onReload: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState<string>();
  const state = usePluginThemeSessionState(source);
  const effective = state?.effective;
  const selected = effective
    ? JSON.stringify([
        effective.pluginId,
        effective.themeId,
        effective.contentHash,
      ])
    : "";
  const value = draft ?? selected;
  const candidate = state?.packs.find(
    ({ theme }) =>
      JSON.stringify([theme.pluginId, theme.id, theme.contentHash]) === value,
  );
  const offered =
    (state?.packs.length ?? 0) > 0 ||
    Boolean(effective || state?.selected || state?.error);
  if (!offered) return null;
  return (
    <section aria-label={t("session.theme.menu")}>
      <div
        className="max-w-72 space-y-2 p-2"
        onClick={(event) => event.stopPropagation()}
      >
        <label className="block text-sm">
          {t("session.theme.menu")}
          <select
            className="mt-1 w-full rounded border bg-background p-2 text-sm"
            aria-label={t("session.theme.menu")}
            disabled={
              !state?.hydrated || state.saving || state.status !== "ready"
            }
            value={value}
            onChange={(event) => setDraft(event.target.value)}
          >
            <option value="">{t("session.theme.defaultOption")}</option>
            {value && !candidate && (
              <option value={value} disabled>
                {t("session.theme.draftUnavailable")}
              </option>
            )}
            {state?.packs.map(({ theme, owner }) => (
              <option
                key={JSON.stringify([theme.pluginId, theme.id])}
                value={JSON.stringify([
                  theme.pluginId,
                  theme.id,
                  theme.contentHash,
                ])}
              >
                {resolveI18nText(theme.label, i18n.language)} · {owner}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ui-menu-item w-full rounded border p-2 text-sm"
          disabled={
            !state?.hydrated ||
            state.saving ||
            state.status !== "ready" ||
            (value !== "" && !candidate)
          }
          onClick={() => {
            const pack = candidate;
            void source
              ?.select(
                pack
                  ? {
                      pluginId: pack.theme.pluginId,
                      themeId: pack.theme.id,
                      contentHash: pack.theme.contentHash,
                    }
                  : null,
              )
              .then((saved) => {
                if (saved) setDraft(undefined);
              });
          }}
        >
          {state?.saving ? t("session.theme.saving") : t("session.theme.apply")}
        </button>
        <p className="text-xs text-muted-foreground" role="status">
          {!state?.hydrated
            ? t("session.theme.readOnly")
            : state.status === "loading"
              ? t("common.loading")
              : state.status === "error"
                ? t("session.theme.loadFailed")
                : effective
                  ? t("session.theme.active", {
                      label: resolveI18nText(
                        effective.theme.label,
                        i18n.language,
                      ),
                      owner: effective.owner,
                    })
                  : state.selected
                    ? t("session.theme.unavailable", {
                        owner: state.selected.pluginId,
                        label: state.selected.themeId,
                      })
                    : t("session.theme.defaultOption")}
        </p>
        {state?.error && (
          <p role="alert" className="text-xs">
            {t(
              state.error === "off-save"
                ? "session.theme.offSaveFailed"
                : state.error === "resource"
                  ? "session.theme.loadFailed"
                  : "settings.saveFailed",
            )}
          </p>
        )}
        {(effective || state?.selected || state?.error || state?.saving) && (
          // Always enabled: going back to the default look must stay possible
          // while a theme is loading, saving or failing.
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void source?.select(null)}
          >
            {t("session.theme.default")}
          </Button>
        )}
        <button type="button" className="text-xs underline" onClick={onReload}>
          {t("common.retry")}
        </button>
      </div>
    </section>
  );
}
