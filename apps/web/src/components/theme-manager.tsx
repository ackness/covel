import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, Palette, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useSetting, useSettingsStore } from "@/settings/use-settings.js";
import { getRegisteredThemes, deleteCustomTheme, saveCustomTheme } from "@/theme-system/registry.js";
import { CUSTOM_THEMES_KEY } from "@/theme-system/storage.js";
import { parseImportedThemeFile } from "@/theme-system/validate.js";
import type { StoredCustomTheme } from "@/theme-system/types.js";

function isCustomTheme(themeId: string, customThemes: StoredCustomTheme[]): boolean {
  return customThemes.some((theme) => theme.id === themeId);
}

function labelToString(
  label: string | Record<string, string>,
  locale: string,
): string {
  if (typeof label === "string") return label;
  return label[locale] ?? label["en-US"] ?? label["zh-CN"] ?? Object.values(label)[0] ?? "";
}

export function ThemeManagerWidget() {
  const { t, i18n } = useTranslation();
  const store = useSettingsStore();
  const [appearance, setAppearance] = useSetting<string>("ui.appearance");
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
      flash(t("settings.themeImported", { name: labelToString(payload.theme.label, i18n.language) }));
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
    const blob = new Blob(
      [JSON.stringify(theme, null, 2)],
      { type: "application/json" },
    );
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
        <div
          className={`text-xs px-3 py-2 rounded-[var(--radius-card)] border ${
            error
              ? "border-destructive/20 bg-destructive/10 text-destructive"
              : "border-primary/20 bg-primary/10 text-primary"
          }`}
        >
          {error ?? notice}
        </div>
      )}

      <div className="border border-border rounded-[var(--radius-card)] bg-card/60 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Palette className="w-4 h-4 text-primary" />
              <p className="text-sm font-medium text-foreground">
                {t("settings.themeLibraryTitle")}
              </p>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("settings.themeLibraryDesc")}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            {t("settings.themeImportButton")}
          </Button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".css,.json,.theme,.theme.json"
          className="hidden"
          onChange={(event) => void handleImport(event)}
        />

        <div className="rounded-[var(--radius-card)] border border-dashed border-border p-3 space-y-2 text-xs text-muted-foreground">
          <p>{t("settings.themeImportHint")}</p>
          <pre className="overflow-auto rounded-[var(--radius-control)] bg-muted/35 px-3 py-2 text-[11px] font-mono leading-relaxed">
{`html[data-theme="my-theme"] {
  --color-background: #10141c;
  --color-foreground: #edf2f7;
  --surface-panel: #151b26;
}`}
          </pre>
        </div>
      </div>

      <div className="space-y-2">
        {themes.map((theme) => {
          const selected = appearance === theme.id;
          const custom = isCustomTheme(theme.id, customThemeList);
          return (
            <div
              key={theme.id}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-border bg-card/40 px-3 py-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate text-sm font-medium text-foreground">
                    {labelToString(theme.label, i18n.language)}
                  </span>
                  <span className="ui-chip text-[10px]">
                    {custom ? t("settings.themeSourceCustom") : t("settings.themeSourceBuiltin")}
                  </span>
                  {selected && (
                    <span className="ui-chip text-[10px]">
                      <Check className="w-3 h-3" />
                      {t("settings.themeActive")}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground font-mono truncate">
                  {theme.id}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
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
