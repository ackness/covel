import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  classifyActionableError,
  type ActionableErrorKind,
} from "@/lib/actionable-error.js";

const MESSAGE_KEYS: Record<ActionableErrorKind, string> = {
  auth: "error.actionable.auth",
  forbidden: "error.actionable.forbidden",
  "not-found": "error.actionable.notFound",
  "rate-limited": "error.actionable.rateLimited",
  server: "error.actionable.server",
  timeout: "error.actionable.timeout",
  network: "error.actionable.network",
  "invalid-output": "error.actionable.invalidOutput",
  incomplete: "error.actionable.incomplete",
  error: "error.actionable.generic",
  unknown: "error.actionable.unknown",
};

const DEFAULT_MESSAGES: Record<ActionableErrorKind, string> = {
  auth: "Authentication failed. Check the API key.",
  forbidden: "The provider rejected this request. Check account permissions.",
  "not-found":
    "The endpoint or model was not found. Check the URL and model ID.",
  "rate-limited":
    "The provider is rate-limiting requests. Check quota and balance.",
  server: "The provider is temporarily unavailable.",
  timeout: "The request timed out. Check the network or proxy.",
  network: "Could not reach the provider. Check the network or proxy.",
  "invalid-output":
    "The model returned data that does not match this task's required format.",
  incomplete:
    "The task stream ended before its final status arrived. Retry this task.",
  error: "The request failed. Open details for the original error.",
  unknown: "The request failed without an error message.",
};

const BADGE_LABELS: Partial<Record<ActionableErrorKind, string>> = {
  "invalid-output": "output",
  incomplete: "incomplete",
};

export function ActionableErrorNotice({
  error,
  kind: kindOverride,
  layout = "inline",
}: {
  error?: string;
  kind?: ActionableErrorKind;
  layout?: "inline" | "panel";
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const detailId = useId();
  const kind = kindOverride ?? classifyActionableError(error);

  useEffect(() => {
    setExpanded(false);
    setCopied(false);
  }, [error]);

  const copyDetail = async () => {
    if (!error) return;
    try {
      await navigator.clipboard.writeText(error);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span
      className={
        layout === "panel"
          ? "block min-w-0 w-full"
          : "inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
      }
    >
      <span
        className={
          layout === "panel"
            ? "flex min-w-0 flex-wrap items-center gap-1.5"
            : "contents"
        }
      >
        <span className="shrink-0 rounded-sm border border-destructive/40 bg-destructive/5 px-1.5 py-0.5 font-mono text-[10px] uppercase text-destructive">
          {BADGE_LABELS[kind] ?? kind}
        </span>
        <span className="min-w-0 text-[11px] text-destructive">
          {t(MESSAGE_KEYS[kind], DEFAULT_MESSAGES[kind])}
        </span>
        {error && (
          <button
            type="button"
            className="shrink-0 text-[10px] text-destructive underline underline-offset-2 hover:text-destructive/80"
            aria-controls={detailId}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
          >
            {expanded
              ? t("error.actionable.hideDetail", "Hide details")
              : t("error.actionable.showDetail", "Show details")}
          </button>
        )}
      </span>
      {expanded && error && (
        <span
          id={detailId}
          className="mt-2 block max-h-40 w-full overflow-auto rounded-sm border border-destructive/25 bg-background/60 p-2 font-mono text-[10px] font-normal normal-case leading-relaxed text-destructive/90 whitespace-pre-wrap wrap-anywhere select-text"
        >
          <span className="block">{error}</span>
          <button
            type="button"
            className="mt-1.5 text-[10px] underline underline-offset-2 hover:text-destructive"
            onClick={(event) => {
              event.stopPropagation();
              void copyDetail();
            }}
          >
            {copied
              ? t("error.actionable.copied", "Copied")
              : t("error.actionable.copyDetail", "Copy details")}
          </button>
          <span className="sr-only" aria-live="polite">
            {copied ? t("error.actionable.copied", "Copied") : ""}
          </span>
        </span>
      )}
    </span>
  );
}
