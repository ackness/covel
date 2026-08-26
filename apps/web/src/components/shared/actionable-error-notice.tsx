import { useEffect, useState } from "react";
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
  error: "The request failed. Open details for the original error.",
  unknown: "The request failed without an error message.",
};

export function ActionableErrorNotice({ error }: { error?: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const kind = classifyActionableError(error);

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
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
      <span className="shrink-0 rounded-sm border border-destructive/40 bg-destructive/5 px-1.5 py-0.5 font-mono text-[10px] uppercase text-destructive">
        {kind}
      </span>
      <span className="min-w-0 text-[11px] text-destructive">
        {t(MESSAGE_KEYS[kind], DEFAULT_MESSAGES[kind])}
      </span>
      {error && (
        <button
          type="button"
          className="shrink-0 text-[10px] text-destructive underline underline-offset-2 hover:text-destructive/80"
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
      {expanded && error && (
        <span className="basis-full rounded-sm border border-destructive/25 bg-destructive/5 p-2 font-mono text-[10px] font-normal normal-case leading-relaxed text-destructive/90 whitespace-pre-wrap break-all select-text">
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
        </span>
      )}
    </span>
  );
}
