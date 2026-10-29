import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";
import type { PackageValidationReport } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { validatePackage } from "@/services/api/package-validation.js";
import {
  groupIssues,
  issueMessage,
  renderPlainText,
} from "./package-validation-model.js";

type Kind = "plugin" | "world";
function useValidation() {
  const { t } = useTranslation();
  const [report, setReport] = useState<PackageValidationReport>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function run(
    kind: Kind,
    source: Parameters<typeof validatePackage>[1],
  ) {
    setBusy(true);
    setError(undefined);
    setReport(undefined);
    try {
      setReport(await validatePackage(kind, source));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("settings.validate.failed"),
      );
    } finally {
      setBusy(false);
    }
  }
  return { report, error, busy, run, setError };
}

function ValidationPanel({ report }: { report: PackageValidationReport }) {
  const { t, i18n } = useTranslation();
  const [copyError, setCopyError] = useState(false);
  const [copied, setCopied] = useState(false);
  const localize = (code: string, message: string) => {
    const key = `settings.validate.codes.${code}`;
    return i18n.exists(key) ? t(key, { message }) : undefined;
  };
  return (
    <div
      className="space-y-2 rounded border border-border p-3 text-xs"
      role="region"
      aria-label={t("settings.validate.report")}
    >
      <p role="status">
        {report.ok
          ? t("settings.validate.noErrors")
          : t("settings.validate.verdict", {
              errors: report.counts.errors,
              warnings: report.counts.warnings,
            })}
        {report.ok && report.counts.warnings > 0
          ? ` · ${t("settings.validate.warnings", { warnings: report.counts.warnings })}`
          : ""}
      </p>
      {report.summary?.languages && (
        <p>
          {t("settings.validate.languages")}: {report.summary.languages}
        </p>
      )}
      {groupIssues(report).map((group) => (
        <section
          key={`${group.severity}:${group.file ?? ""}`}
          className="space-y-1"
        >
          <h4 className="font-semibold">
            {t(`settings.validate.${group.severity}`)} ·{" "}
            <code>{group.file ?? t("settings.validate.package")}</code>
          </h4>
          <ul className="space-y-2">
            {group.issues.map((issue, index) => (
              <li key={index} className="wrap-break-word">
                {issue.field && <code className="block">{issue.field}</code>}
                <p>{issueMessage(issue, localize)}</p>
                {issue.hint && (
                  <p className="text-muted-foreground">{issue.hint}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setCopied(false);
          setCopyError(false);
          void (async () => {
            try {
              await navigator.clipboard.writeText(
                renderPlainText(report, localize),
              );
              setCopied(true);
            } catch {
              setCopyError(true);
            }
          })();
        }}
      >
        {t("settings.validate.copy")}
      </Button>
      {copied && <p role="status">{t("settings.validate.copied")}</p>}
      {copyError && <p role="alert">{t("settings.validate.copyFailed")}</p>}
    </div>
  );
}

export function PackageValidationButton({
  kind,
  id,
  disabled,
}: {
  kind: Kind;
  id: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const state = useValidation();
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || state.busy}
        onClick={() => void state.run(kind, { kind: "installed", id })}
      >
        {state.busy && (
          <LoaderCircle
            className="mr-1 size-3 animate-spin"
            aria-hidden="true"
          />
        )}
        {t(
          state.busy
            ? "settings.validate.validating"
            : "settings.validate.button",
        )}
      </Button>
      {state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
      {state.report && <ValidationPanel report={state.report} />}
    </div>
  );
}

export function PackageValidationZip({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>("plugin");
  const state = useValidation();
  const blocked = disabled || state.busy;
  function upload(file: File | undefined) {
    if (!file || blocked) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      state.setError(t("settings.validate.invalidZip"));
      return;
    }
    void state.run(kind, { kind: "upload", file });
  }
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold">
        {t("settings.validate.zipTitle")}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t("settings.validate.zipHint")}
      </p>
      <div className="flex gap-2">
        {(["plugin", "world"] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={kind === value ? "default" : "outline"}
            aria-pressed={kind === value}
            disabled={blocked}
            onClick={() => setKind(value)}
          >
            {t(`settings.validate.${value}`)}
          </Button>
        ))}
      </div>
      <label
        className="block rounded border border-dashed border-border p-3 text-xs"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          upload(event.dataTransfer.files[0]);
        }}
      >
        {t(
          state.busy
            ? "settings.validate.validating"
            : "settings.validate.chooseZip",
        )}
        <input
          type="file"
          accept=".zip"
          aria-label={t("settings.validate.chooseZip")}
          disabled={blocked}
          className="block mt-2"
          onChange={(event) => {
            upload(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </label>
      {state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
      {state.report && <ValidationPanel report={state.report} />}
    </section>
  );
}
