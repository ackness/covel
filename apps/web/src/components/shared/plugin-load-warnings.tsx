import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PluginLoadDiagnostics } from "@covel/shared";

/** Partial-load warnings stay visible even when advanced settings are closed. */
export function PluginLoadWarnings({
  diagnostics,
}: {
  diagnostics?: PluginLoadDiagnostics;
}) {
  const { t } = useTranslation();
  const rows = [
    ...(diagnostics?.disabledRuntimes ?? []).map((runtime) => ({
      key: `runtime:${runtime.sourcePath}`,
      label: t("plugin.loadWarnings.runtime", { path: runtime.sourcePath }),
      message: runtime.message,
    })),
    ...(diagnostics?.ignoredFields ?? []).map((field) => ({
      key: `field:${field.sourcePath}:${field.field}`,
      label: t("plugin.loadWarnings.field", {
        path: field.sourcePath,
        field: field.field,
      }),
      message: field.message,
    })),
  ];
  if (!rows.length) return null;
  return (
    <ul
      aria-label={t("plugin.loadWarnings.label")}
      className="space-y-2 p-2.5 text-xs text-amber-700 dark:text-amber-300"
    >
      {rows.map((row) => (
        <li key={row.key} className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p className="wrap-break-word">{row.label}</p>
            <details>
              <summary className="cursor-pointer">
                {t("plugin.loadWarnings.details")}
              </summary>
              <p className="mt-1 whitespace-pre-wrap break-all font-mono">
                {row.message}
              </p>
            </details>
          </div>
        </li>
      ))}
    </ul>
  );
}
