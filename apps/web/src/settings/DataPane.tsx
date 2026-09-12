import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, RotateCw, Upload } from "lucide-react";
import { z } from "zod";
import type { SettingsExportBundle } from "@covel/settings";
import { Button } from "@/components/ui/button.js";
import { useSettingsStore } from "./use-settings.js";

const importBundleSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string().default(""),
  entries: z.record(z.string(), z.unknown()),
  keys: z.record(z.string(), z.string()).optional(),
});

/**
 * Import / Export / Reset pane. Always visible, even when no entries exist
 * in the `data` group.
 */
export function DataPane() {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [pending, setPending] = useState<{
    bundle: SettingsExportBundle;
    keys: Set<string>;
    includeSecrets: boolean;
    invalidKeys: Set<string>;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleExport() {
    setError(null);
    try {
      const bundle = await store.export({ includeSecrets });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `covel-settings-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      flash(t("settings.exported"));
    } catch {
      setError(t("settings.dataOperationFailed"));
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const bundle = importBundleSchema.parse(JSON.parse(await file.text()));
      const registry = new Map(
        store.listEntries().map((entry) => [entry.key, entry]),
      );
      const invalidKeys = new Set(
        Object.entries(bundle.entries).flatMap(([key, value]) => {
          const entry = registry.get(key);
          return key.startsWith("keys.") ||
            entry?.secret ||
            entry?.backend === "keys" ||
            (entry && !entry.schema.safeParse(value).success)
            ? [key]
            : [];
        }),
      );
      setPending({
        bundle,
        keys: new Set(
          Object.keys(bundle.entries).filter((key) => !invalidKeys.has(key)),
        ),
        includeSecrets: Boolean(bundle.keys),
        invalidKeys,
      });
    } catch {
      setPending(null);
      setError(t("settings.importInvalid"));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleApplyImport() {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      await store.import(pending.bundle, {
        keys: [...pending.keys],
        includeSecrets: pending.includeSecrets,
      });
      setPending(null);
      flash(t("settings.imported"));
    } catch {
      setError(t("settings.dataOperationFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleResetAll() {
    if (busy || !confirm(t("settings.resetAllConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await store.clearAll();
      flash(t("settings.reset"));
    } catch {
      setError(t("settings.dataOperationFailed"));
    } finally {
      setBusy(false);
    }
  }

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  return (
    <div className="space-y-5">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {toast && (
        <div className="text-xs px-3 py-2 rounded bg-primary/10 border border-primary/20 text-primary">
          {toast}
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {t("settings.exportHeader")}
        </h3>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeSecrets}
            onChange={(e) => setIncludeSecrets(e.target.checked)}
          />
          {t("settings.exportIncludeKeys")}
        </label>
        <Button
          size="sm"
          variant="outline"
          onClick={handleExport}
          disabled={busy}
        >
          <Download className="w-3 h-3 mr-1" />
          {t("settings.exportDownload")}
        </Button>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {t("settings.importHeader")}
        </h3>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="w-3 h-3 mr-1" />
          {t("settings.importChoose")}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          aria-label={t("settings.importChoose")}
          className="hidden"
          onChange={handleFile}
        />
        {pending && (
          <div className="border border-border rounded p-3 space-y-2 text-xs">
            <div className="font-medium">{t("settings.importPreview")}</div>
            {pending.invalidKeys.size > 0 && (
              <p role="status">
                {t("settings.importInvalidEntries", {
                  count: pending.invalidKeys.size,
                })}
              </p>
            )}
            <ul className="space-y-1 max-h-40 overflow-y-auto">
              {Object.entries(pending.bundle.entries).map(([key, value]) => (
                <li key={key} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={key}
                    disabled={busy || pending.invalidKeys.has(key)}
                    checked={pending.keys.has(key)}
                    onChange={(e) => {
                      const next = new Set(pending.keys);
                      if (e.target.checked) next.add(key);
                      else next.delete(key);
                      setPending({ ...pending, keys: next });
                    }}
                  />
                  <span className="font-mono truncate max-w-45">{key}</span>
                  <span className="text-muted-foreground truncate flex-1">
                    = {JSON.stringify(value)}
                  </span>
                </li>
              ))}
            </ul>
            {pending.bundle.keys && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={pending.includeSecrets}
                  onChange={(e) =>
                    setPending({ ...pending, includeSecrets: e.target.checked })
                  }
                />
                {t("settings.importKeysCount", {
                  count: Object.keys(pending.bundle.keys).length,
                })}
              </label>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleApplyImport}
                disabled={
                  busy ||
                  (pending.keys.size === 0 &&
                    !(
                      pending.includeSecrets &&
                      Object.keys(pending.bundle.keys ?? {}).length > 0
                    ))
                }
              >
                {t("settings.importApply", { count: pending.keys.size })}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {t("settings.resetHeader")}
        </h3>
        <Button
          size="sm"
          variant="outline"
          onClick={handleResetAll}
          disabled={busy}
        >
          <RotateCw className="w-3 h-3 mr-1" />
          {t("settings.resetAll")}
        </Button>
      </section>
    </div>
  );
}
