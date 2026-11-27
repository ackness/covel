import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, FileJson, Loader2 } from "lucide-react";
import type { StImportReport } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { useLocalePreference } from "@/hooks/useLocalePreference.js";
import { localeDefinitions } from "@/i18n/catalog-registry.js";
import { localeOptionLabel } from "@/i18n/locale-option-label.js";
import { importStContent } from "@/services/api/st-import.js";
import { PaneNotice, usePaneNotice } from "../pane-notice.js";
import { groupImportItems, importItemText } from "./st-import-model.js";

export function StImportCard({
  busy,
  onImported,
  onBusyChange,
}: {
  busy: boolean;
  onImported(): void;
  onBusyChange?(busy: boolean): void;
}) {
  const { t, i18n } = useTranslation();
  const preference = useLocalePreference();
  const [locale, setLocale] = useState(preference.locale);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [report, setReport] = useState<StImportReport | null>(null);
  const [working, setWorking] = useState(false);
  const { notice, show: flash } = usePaneNotice();
  const picker = useRef<HTMLInputElement>(null);
  const disabled = busy || working;
  const groups = report ? groupImportItems(report.items) : [];

  function invalidate() {
    setReport(null);
  }

  async function submit(preview: boolean) {
    setWorking(true);
    onBusyChange?.(true);
    try {
      const result = await importStContent({ files, locale, name, preview });
      if (preview) setReport(result.report);
      else {
        flash({ tone: "success", message: t("settings.stImport.success") });
        onImported();
        setReport(null);
        setFiles([]);
        setName("");
        setLocale(preference.locale);
        if (picker.current) picker.current.value = "";
      }
    } catch (error) {
      setReport(null);
      flash({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setWorking(false);
      onBusyChange?.(false);
    }
  }

  return (
    <section className="space-y-3.5 rounded-lg border border-border bg-card/40 p-4">
      <div className="space-y-1">
        <h3 className="settings-section-title flex items-center gap-1.5">
          <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
          {t("settings.stImport.title")}
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.stImport.hint")}
        </p>
      </div>

      <PaneNotice notice={notice} />

      <fieldset disabled={disabled} className="space-y-3">
        <label className="block space-y-2 rounded-md border border-dashed border-border bg-background/60 p-3 text-xs transition-colors hover:border-primary/50">
          <span className="block font-medium text-foreground">
            {t("settings.stImport.files")}
          </span>
          <input
            ref={picker}
            type="file"
            aria-label={t("settings.stImport.files")}
            accept=".png,.json,application/json,image/png"
            multiple
            className="block w-full text-xs text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted/60"
            onChange={(event) => {
              setFiles(Array.from(event.target.files ?? []));
              invalidate();
            }}
          />
          {files.length > 0 && (
            <span className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto pt-0.5">
              {files.map((file, idx) => (
                <span
                  key={`${file.name}:${idx}`}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground"
                >
                  <FileJson className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate" title={file.name}>
                    {file.name}
                  </span>
                </span>
              ))}
            </span>
          )}
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-muted-foreground">
            {t("settings.stImport.locale")}
            <select
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
              value={locale}
              onChange={(event) => {
                setLocale(event.target.value);
                invalidate();
              }}
            >
              {localeDefinitions.map((definition) => (
                <option key={definition.code} value={definition.code}>
                  {localeOptionLabel(
                    definition,
                    t("onboarding.languageExperimental", "experimental"),
                  )}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-muted-foreground">
            {t("settings.stImport.name")}
            <input
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
              value={name}
              maxLength={200}
              onChange={(event) => {
                setName(event.target.value);
                invalidate();
              }}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button
            size="sm"
            variant={report ? "outline" : "default"}
            disabled={!files.length || disabled}
            onClick={() => void submit(true)}
          >
            {working && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t("settings.stImport.preview")}
          </Button>
          {report && (
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => void submit(false)}
            >
              {t("settings.stImport.import")}
            </Button>
          )}
        </div>
      </fieldset>

      {report && (
        <div
          className="space-y-2.5 rounded-md border border-border bg-background/70 p-3 text-xs"
          aria-live="polite"
        >
          <div className="space-y-0.5">
            <p className="font-semibold text-foreground">
              {report.world.name} · {report.world.id}
            </p>
            <p className="text-muted-foreground">
              {t("settings.stImport.counts", {
                characters: report.counts.characters,
                entries: report.counts.loreEntries,
                cover: report.counts.hasCover
                  ? t("common.yes")
                  : t("common.no"),
              })}
            </p>
          </div>
          {groups.length > 0 && (
            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {groups.map((group) => (
                <div key={group.level} className="space-y-1">
                  <h4 className="font-semibold text-foreground">
                    {t(`settings.stImport.levels.${group.level}`)}
                  </h4>
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {group.items.map((item, index) => (
                      <li key={index}>
                        {item.source ? `${item.source}: ` : ""}
                        {importItemText(
                          item,
                          (key) => t(key),
                          (key) => i18n.exists(key),
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
