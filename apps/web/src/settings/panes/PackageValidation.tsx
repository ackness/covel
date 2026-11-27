import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FileArchive,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
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
  const groups = groupIssues(report);
  return (
    <div
      className="space-y-2.5 rounded-md border border-border bg-background/70 p-3 text-xs"
      role="region"
      aria-label={t("settings.validate.report")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {report.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          )}
          <p role="status" className="font-medium text-foreground">
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
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {t("settings.validate.languages")}: {report.summary.languages}
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2.5 text-[11px]"
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
          <Copy className="h-3 w-3" />
          {t("settings.validate.copy")}
        </Button>
      </div>

      {groups.length > 0 && (
        <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {groups.map((group) => (
            <section
              key={`${group.severity}:${group.file ?? ""}`}
              className={`space-y-1.5 rounded border p-2.5 ${
                group.severity === "error"
                  ? "border-destructive/30 bg-destructive/5"
                  : "border-(--accent-warning)/30 bg-(--accent-warning)/5"
              }`}
            >
              <h4 className="font-semibold text-foreground">
                {t(`settings.validate.${group.severity}`)} ·{" "}
                <code className="font-mono text-[11px]">
                  {group.file ?? t("settings.validate.package")}
                </code>
              </h4>
              <ul className="space-y-1.5">
                {group.issues.map((issue, index) => (
                  <li
                    key={index}
                    className="space-y-0.5 border-l-2 border-border pl-2 wrap-break-word"
                  >
                    {issue.field && (
                      <code className="block font-mono text-[11px] text-foreground">
                        {issue.field}
                      </code>
                    )}
                    <p className="text-foreground/90">
                      {issueMessage(issue, localize)}
                    </p>
                    {issue.hint && (
                      <p className="text-muted-foreground">{issue.hint}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {copied && (
        <p role="status" className="text-[11px] text-emerald-500">
          {t("settings.validate.copied")}
        </p>
      )}
      {copyError && (
        <p role="alert" className="text-[11px] text-destructive">
          {t("settings.validate.copyFailed")}
        </p>
      )}
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
  const hasDetails = Boolean(state.error || state.report);
  return (
    <div className={hasDetails ? "w-full space-y-2" : "contents"}>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 px-2.5 text-xs"
        disabled={disabled || state.busy}
        onClick={() => void state.run(kind, { kind: "installed", id })}
      >
        {state.busy ? (
          <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
        ) : (
          <ShieldCheck className="size-3" aria-hidden="true" />
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
    <section className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="settings-section-title flex items-center gap-1.5">
            <FileArchive className="h-3.5 w-3.5 text-muted-foreground" />
            {t("settings.validate.zipTitle")}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("settings.validate.zipHint")}
          </p>
        </div>
        <div className="inline-flex rounded-md border border-border bg-background p-0.5">
          {(["plugin", "world"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={kind === value ? "default" : "ghost"}
              className="h-7 px-3 text-xs"
              aria-pressed={kind === value}
              disabled={blocked}
              onClick={() => setKind(value)}
            >
              {t(`settings.validate.${value}`)}
            </Button>
          ))}
        </div>
      </div>

      <label
        className={`flex cursor-pointer flex-col gap-2 rounded-md border border-dashed border-border bg-background/60 p-3.5 text-xs transition-colors hover:border-primary/50 hover:bg-muted/20 ${
          blocked ? "opacity-60" : ""
        }`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          upload(event.dataTransfer.files[0]);
        }}
      >
        <span className="font-medium text-foreground">
          {t(
            state.busy
              ? "settings.validate.validating"
              : "settings.validate.chooseZip",
          )}
        </span>
        <input
          type="file"
          accept=".zip"
          aria-label={t("settings.validate.chooseZip")}
          disabled={blocked}
          className="block w-full text-xs text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted/60"
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
