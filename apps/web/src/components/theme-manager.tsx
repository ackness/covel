import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, Palette, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useSetting, useSettingsStore } from "@/settings/use-settings.js";
import {
  getRegisteredThemes,
  deleteCustomTheme,
  saveCustomTheme,
  THEME_SCHEME_KEY,
} from "@/theme-system/registry.js";
import { CUSTOM_THEMES_KEY } from "@/theme-system/storage.js";
import { parseImportedThemeFile } from "@/theme-system/validate.js";
import type { StoredCustomTheme, ThemeScheme } from "@/theme-system/types.js";

function isCustomTheme(
  themeId: string,
  customThemes: StoredCustomTheme[],
): boolean {
  return customThemes.some((theme) => theme.id === themeId);
}

function labelToString(
  label: string | Record<string, string>,
  locale: string,
): string {
  if (typeof label === "string") return label;
  return (
    label[locale] ??
    label["en-US"] ??
    label["zh-CN"] ??
    Object.values(label)[0] ??
    ""
  );
}

export function ThemeManagerWidget() {
  const { t, i18n } = useTranslation();
  const store = useSettingsStore();
  const [appearance, setAppearance] = useSetting<string>("ui.appearance");
  const [scheme, setScheme] = useSetting<ThemeScheme>(THEME_SCHEME_KEY);
  const [customThemes] = useSetting<StoredCustomTheme[]>(CUSTOM_THEMES_KEY);
  const fileRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const customThemeList = customThemes ?? [];
  const themes = useMemo(() => getRegisteredThemes(), [customThemeList]);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(null), 2500);
  }

  async function handleImport(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;

    setBusy(true);
    setError(null);

    try {
      const text = await file.text();
      const payload = parseImportedThemeFile(text, file.name);
      await saveCustomTheme(store, payload.theme, payload.fileName);
      await setAppearance(payload.theme.id);
      flash(
        t("settings.themeImported", {
          name: labelToString(payload.theme.label, i18n.language),
        }),
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : t("settings.themeImportInvalid"),
      );
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleDelete(themeId: string): Promise<void> {
    setBusy(true);
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
      {(notice || error) && (
        <div className="ui-band text-xs" data-tone={error ? "danger" : "info"}>
          <span
            className={
              error
                ? "text-[var(--accent-danger)]"
                : "text-[var(--accent-secondary)]"
            }
          >
            {error ?? notice}
          </span>
        </div>
      )}

      <div className="ui-section pb-4">
        <div className="ui-section-head">
          <Palette className="w-4 h-4 opacity-60" />
          <span className="ui-section-title">
            {t("settings.themeLibraryTitle")}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto shrink-0"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            {t("settings.themeImportButton")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed mb-3">
          {t("settings.themeLibraryDesc")}
        </p>

        <input
          ref={fileRef}
          type="file"
          accept=".css,.json,.theme,.theme.json"
          className="hidden"
          onChange={(event) => void handleImport(event)}
        />

        <div className="ui-frame p-3 space-y-2 text-xs text-muted-foreground">
          <p>{t("settings.themeImportHint")}</p>
          <pre
            className="overflow-auto rounded-[var(--radius-control)] px-3 py-2 text-[11px] font-mono leading-relaxed"
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
      </div>

      <div className="space-y-0">
        {themes.map((theme) => {
          const selected = appearance === theme.id;
          const custom = isCustomTheme(theme.id, customThemeList);
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
                {selected && (
                  <div
                    className="flex items-center overflow-hidden rounded-[var(--radius-control)] border border-[var(--rule-color)]"
                    aria-label={t("settings.themeSchemeLabel")}
                  >
                    {(["light", "dark"] as const).map((nextScheme) => {
                      const supported = theme.schemes.includes(nextScheme);
                      return (
                        <Button
                          key={nextScheme}
                          size="sm"
                          variant="ghost"
                          disabled={busy || !supported}
                          className={
                            "h-7 rounded-none border-0 px-2 text-[11px] " +
                            (scheme === nextScheme
                              ? "bg-foreground text-[var(--surface-page)]"
                              : "text-muted-foreground")
                          }
                          onClick={() => void setScheme(nextScheme)}
                        >
                          {t(`settings.themeScheme.${nextScheme}`)}
                        </Button>
                      );
                    })}
                  </div>
                )}
                {!selected && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void setAppearance(theme.id)}
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
                      <Download className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
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
    </div>
  );
}
