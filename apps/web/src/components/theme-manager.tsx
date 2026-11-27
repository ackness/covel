import {
  SettingsListFilter,
  SettingsListSearch,
} from "@/settings/list-controls.js";
import { storedThemeSelection } from "@/theme-system/selection.js";
import {
  checkThemeContrast,
  type ThemeContrastResult,
} from "@/theme-system/contrast.js";
import { ContrastNotice } from "@/components/appearance/ContrastNotice.js";
import { importCssImages } from "@/lib/import-image.js";
import { useSettingsWritable } from "@/settings/use-settings-save.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveI18nText } from "@covel/shared";
import {
  Check,
  ChevronRight,
  FileInput,
  FileOutput,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useSetting, useSettingsStore } from "@/settings/use-settings.js";
import {
  getRegisteredThemes,
  deleteCustomTheme,
  saveCustomTheme,
} from "@/theme-system/registry.js";
import {
  CUSTOM_THEMES_KEY,
  loadStoredCustomThemes,
} from "@/theme-system/storage.js";
import { parseImportedThemeFile } from "@/theme-system/validate.js";
import { themeImportErrorText } from "@/theme-system/import-error.js";

function labelToString(
  label: string | Record<string, string>,
  locale: string,
): string {
  return resolveI18nText(label, locale) ?? "";
}

export function ThemeManagerWidget() {
  const { t, i18n } = useTranslation();
  const store = useSettingsStore();
  const writable = useSettingsWritable();
  useSetting<string>("ui.appearance");
  const [customThemes] = useSetting<unknown>(CUSTOM_THEMES_KEY);
  const fileRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contrast, setContrast] = useState<ThemeContrastResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [themeQuery, setThemeQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<
    "all" | "custom" | "builtin"
  >("all");

  const customThemeList = useMemo(
    () => loadStoredCustomThemes(store),
    [store, customThemes],
  );
  const themes = getRegisteredThemes();
  const appearance = storedThemeSelection(store).id;
  const customCount = themes.filter(
    (theme) => theme.source === "custom",
  ).length;
  const builtinCount = themes.length - customCount;
  const showSourcePills = customCount > 0 && builtinCount > 0;
  const activeSourceFilter = showSourcePills ? sourceFilter : "all";
  const normalizedQuery = themeQuery.trim().toLowerCase();
  const filteredThemes = themes.filter((theme) => {
    if (activeSourceFilter !== "all" && theme.source !== activeSourceFilter)
      return false;
    if (!normalizedQuery) return true;
    const displayLabel = labelToString(theme.label, i18n.language);
    return (
      theme.id.toLowerCase().includes(normalizedQuery) ||
      displayLabel.toLowerCase().includes(normalizedQuery)
    );
  });
  const showThemeSearch = themes.length > 6 || !!themeQuery;

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  function flash(message: string) {
    setNotice(message);
    // A later notice restarts the timer; unmounting cancels it.
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  }

  async function handleImport(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    setContrast([]);

    try {
      const text = await file.text();
      const payload = parseImportedThemeFile(text, file.name);
      setContrast(checkThemeContrast(payload.theme));
      await saveCustomTheme(
        store,
        {
          ...payload.theme,
          cssText: await importCssImages(payload.theme.cssText),
        },
        payload.fileName,
      );
      await store.set("ui.appearance", payload.theme.id);
      flash(
        t("settings.themeImported", {
          name: labelToString(payload.theme.label, i18n.language),
        }),
      );
    } catch (nextError) {
      setError(
        themeImportErrorText(nextError, t, "settings.themeImportInvalid"),
      );
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleApply(themeId: string): Promise<void> {
    setContrast([]);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await store.set("ui.appearance", themeId);
    } catch {
      setError(t("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(themeId: string): Promise<void> {
    if (!writable || busy) return;
    setBusy(true);
    if (
      !(await requestConfirm({
        title: t("settings.deleteThemeTitle"),
        message: t("settings.deleteThemeConfirm"),
        subject: themeId,
        confirmLabel: t("common.delete"),
        cancelLabel: t("common.cancel"),
        destructive: true,
      }))
    ) {
      setBusy(false);
      return;
    }
    setError(null);
    try {
      await deleteCustomTheme(store, themeId);
      flash(t("settings.themeDeleted"));
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : t("settings.themeDeleteFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  function handleExport(themeId: string): void {
    const theme = customThemeList.find((entry) => entry.id === themeId);
    if (!theme) return;
    const blob = new Blob([JSON.stringify(theme, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${theme.id}.theme.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <ContrastNotice results={contrast} />
      {(notice || error) && (
        <div
          role={error ? "alert" : "status"}
          className="ui-band text-xs"
          data-tone={error ? "danger" : "info"}
        >
          <span
            className={
              error ? "text-(--accent-danger)" : "text-(--accent-secondary)"
            }
          >
            {error ?? notice}
          </span>
        </div>
      )}

      <div className="ui-section pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("settings.themeLibraryDesc")}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-auto max-w-full py-1.5 whitespace-normal"
            disabled={busy || !writable}
            onClick={() => fileRef.current?.click()}
          >
            <FileInput data-icon="inline-start" />
            {t("settings.themeImportButton")}
          </Button>
        </div>

        <input
          ref={fileRef}
          type="file"
          disabled={!writable}
          accept=".css,.json,.theme,.theme.json"
          className="hidden"
          onChange={(event) => void handleImport(event)}
        />
      </div>

      {(showThemeSearch || showSourcePills) && (
        <div className="flex flex-wrap items-center gap-2">
          {showThemeSearch && (
            <SettingsListSearch
              label={t("settings.themeSearchPlaceholder")}
              value={themeQuery}
              onChange={setThemeQuery}
            />
          )}
          {showSourcePills && (
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  {
                    id: "all",
                    label: t("settings.themeFilterAll", {
                      count: themes.length,
                      defaultValue: "All ({{count}})",
                    }),
                  },
                  {
                    id: "custom",
                    label: `${t("settings.themeSourceCustom")} (${customCount})`,
                  },
                  {
                    id: "builtin",
                    label: `${t("settings.themeSourceBuiltin")} (${builtinCount})`,
                  },
                ] as const
              ).map((pill) => (
                <SettingsListFilter
                  key={pill.id}
                  active={activeSourceFilter === pill.id}
                  onClick={() => setSourceFilter(pill.id)}
                  label={pill.label}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {filteredThemes.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
          <p className="text-xs text-muted-foreground">
            {t(
              "settings.themeFilterEmpty",
              "No themes match the current filter.",
            )}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              setThemeQuery("");
              setSourceFilter("all");
            }}
          >
            {t("settings.github.resetFilters")}
          </Button>
        </div>
      ) : (
        <div
          className={
            filteredThemes.length > 6
              ? "max-h-96 overflow-y-auto space-y-0 pr-1"
              : "space-y-0"
          }
        >
          {filteredThemes.map((theme) => {
            const selected = appearance === theme.id;
            const custom = theme.source === "custom";
            return (
              <div
                key={theme.id}
                className="ui-band flex items-center justify-between gap-3 py-3"
                data-tone={selected ? undefined : "muted"}
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <span className="ui-section-title truncate">
                      {labelToString(theme.label, i18n.language)}
                    </span>
                    <span className="ui-tag">
                      {custom
                        ? t("settings.themeSourceCustom")
                        : t("settings.themeSourceBuiltin")}
                    </span>
                    {selected && (
                      <span className="ui-tag ui-tag-solid inline-flex items-center gap-1">
                        <Check className="w-2.5 h-2.5" />
                        {t("settings.themeActive")}
                      </span>
                    )}
                  </div>
                  <p className="ui-meta truncate">
                    {theme.id} ·{" "}
                    {theme.schemes
                      .map((themeScheme) =>
                        t(`settings.themeScheme.${themeScheme}`),
                      )
                      .join(" / ")}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                  {!selected && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !writable}
                      onClick={() => void handleApply(theme.id)}
                    >
                      {t("settings.themeApply")}
                    </Button>
                  )}
                  {custom && (
                    <>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => handleExport(theme.id)}
                        aria-label={t("settings.export")}
                      >
                        <FileOutput />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={busy || !writable}
                        onClick={() => void handleDelete(theme.id)}
                        aria-label={t("common.delete", "Delete")}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <details className="group ui-frame p-3 text-xs text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-foreground/85 hover:text-foreground">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <span>
            {t(
              "settings.themeCssExampleToggle",
              "Show theme CSS format example",
            )}
          </span>
        </summary>
        <div className="mt-2.5 space-y-2">
          <p>{t("settings.themeImportHint")}</p>
          <pre
            className="overflow-auto rounded-(--radius-control) px-3 py-2 text-[11px] font-mono leading-relaxed"
            style={{ background: "var(--surface-page)" }}
          >
            {`html[data-theme="my-theme"] {
  --color-background: #10141c;
  --color-foreground: #edf2f7;
  --accent-primary: #ff7a45;
  --rule-color: #1f2937;
  --noise-opacity: 0.04;
}

html[data-theme="my-theme"].dark {
  --color-background: #090b10;
}`}
          </pre>
        </div>
      </details>
    </div>
  );
}
