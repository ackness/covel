import { useId } from "react";
import { useTranslation } from "react-i18next";
import { resolveLlmTokenLimits } from "@covel/shared";
import {
  SettingsDraftConflict,
  useSettingDraft,
} from "../use-setting-draft.js";

export function MaxOutputTokensCard({
  override,
  defaultValue,
  modelLimit,
  contextWindow,
  onChange,
}: {
  override: number | undefined;
  defaultValue?: number;
  modelLimit?: number;
  contextWindow?: number;
  onChange: (value: number | undefined) => void;
}) {
  const { t } = useTranslation();
  const errorId = useId();
  const { draft, setDraft, conflict, reset } = useSettingDraft(
    String(override ?? ""),
  );
  const parsed = draft.trim() ? Number(draft) : undefined;
  const valid =
    parsed === undefined ||
    (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1_000_000);
  const commit = () => {
    if (!conflict && valid && parsed !== override) onChange(parsed);
  };
  let effectiveOutput: number | undefined;
  let inputBudget: number | undefined;
  let budgetInvalid = false;
  try {
    const limits = resolveLlmTokenLimits({
      contextWindow,
      maxOutputTokens: modelLimit,
      requestedMaxOutputTokens: override ?? defaultValue,
    });
    effectiveOutput = limits.maxOutputTokens;
    inputBudget = limits.contextWindow - limits.maxOutputTokens;
  } catch {
    budgetInvalid = true;
  }
  return (
    <div className="border border-border p-3 space-y-3 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">
            {t("settings.maxOutputTokens", "Max output tokens")}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {t(
              "settings.maxOutputTokensHint",
              "Limits output, not input context. Tasks default to 16,384 tokens; you can raise or lower this value for complex calls and reasoning. The selected model and context budget still constrain the request. Catalog limits are reference values; use Edit Capabilities to correct them for your provider.",
            )}
          </p>
        </div>
        {override !== undefined && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="shrink-0 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("settings.useDefault", "Use default")}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <ValueCell
          label={t("settings.defaultValue", "Default")}
          value={
            defaultValue?.toLocaleString() ??
            t("settings.taskOutputDefault", "Task default (up to 16,384)")
          }
        />
        <ValueCell
          label={t("settings.requestedOutputLimit", "Requested limit")}
          value={
            (override ?? defaultValue)?.toLocaleString() ??
            t("settings.taskOutputDefault", "Task default (up to 16,384)")
          }
          active={override !== undefined}
        />
      </div>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
        <input
          aria-label={t("settings.maxOutputTokens", "Max output tokens")}
          type="number"
          min={1}
          max={1_000_000}
          step={1}
          placeholder={t("settings.numberPlaceholder", "e.g. 4096")}
          value={draft}
          aria-invalid={!valid}
          aria-describedby={!valid ? errorId : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="min-w-0 flex-1 border border-border bg-background px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-primary"
        />
        {modelLimit === undefined && (
          <span className="text-[10px] text-muted-foreground">
            {t("settings.modelLimitsUnknown", {
              defaultValue: "Model limits unknown",
            })}
          </span>
        )}
        {modelLimit !== undefined && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {t("settings.modelOutputLimit", {
              value: modelLimit.toLocaleString(),
              defaultValue: "Reference model limit: {{value}}",
            })}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <ValueCell
          label={t("settings.effectiveOutputBudget", "Effective output budget")}
          value={effectiveOutput?.toLocaleString() ?? "—"}
        />
        <ValueCell
          label={t("settings.remainingInputBudget", "Remaining input budget")}
          value={inputBudget?.toLocaleString() ?? "—"}
        />
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {t(
          "settings.tokenBudgetPreviewHint",
          "Budget preview uses this configuration. Input includes system instructions, history and tools. Unknown context windows use 32,768; server limits may reduce the budget.",
        )}
      </p>
      {budgetInvalid && (
        <p role="alert" className="text-xs text-destructive">
          {t(
            "settings.outputBudgetConflict",
            "The output budget must leave room for input in the context window. Lower the output limit or correct the model's context window.",
          )}
        </p>
      )}
      {!valid && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {t("settings.maxOutputTokensInvalid", {
            defaultValue: "Enter a whole number between 1 and 1,000,000.",
          })}
        </p>
      )}
      {conflict && <SettingsDraftConflict onReload={reset} />}
    </div>
  );
}

export function ValueCell({
  label,
  value,
  active = false,
}: {
  label: string;
  value: string;
  active?: boolean;
}) {
  return (
    <div
      className={
        active
          ? "border border-primary/40 bg-primary/5 px-2 py-1.5"
          : "border border-border/60 bg-muted/20 px-2 py-1.5"
      }
    >
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-xs tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}
