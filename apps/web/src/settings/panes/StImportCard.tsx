import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
    <section className="space-y-3 rounded border border-border p-3">
      <h3 className="text-sm font-semibold">{t("settings.stImport.title")}</h3>
      <p className="text-xs text-muted-foreground">
        {t("settings.stImport.hint")}
      </p>
      <PaneNotice notice={notice} />
      <fieldset disabled={disabled} className="space-y-3">
        <label className="block text-xs">
          {t("settings.stImport.files")}
          <input
            ref={picker}
            type="file"
            accept=".png,.json,application/json,image/png"
            multiple
            className="mt-1 block w-full text-xs"
            onChange={(event) => {
              setFiles(Array.from(event.target.files ?? []));
              invalidate();
            }}
          />
        </label>
        <label className="block text-xs">
          {t("settings.stImport.locale")}
          <select
            className="mt-1 block w-full rounded border border-border bg-background p-2"
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
        <label className="block text-xs">
          {t("settings.stImport.name")}
          <input
            className="mt-1 block w-full rounded border border-border bg-background p-2"
            value={name}
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value);
              invalidate();
            }}
          />
        </label>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!files.length || disabled}
            onClick={() => void submit(true)}
          >
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
        <div className="space-y-2 text-xs" aria-live="polite">
          <p>
            {report.world.name} · {report.world.id}
          </p>
          <p>
            {t("settings.stImport.counts", {
              characters: report.counts.characters,
              entries: report.counts.loreEntries,
              cover: report.counts.hasCover ? t("common.yes") : t("common.no"),
            })}
          </p>
          {groupImportItems(report.items).map((group) => (
            <div key={group.level}>
              <h4 className="font-semibold">
                {t(`settings.stImport.levels.${group.level}`)}
              </h4>
              <ul className="list-disc space-y-1 pl-5">
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
    </section>
  );
}
