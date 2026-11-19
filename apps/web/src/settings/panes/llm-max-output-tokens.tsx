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
  onChange: (value: number | undefined) => Promise<boolean> | void;
}) {
  const { t, i18n } = useTranslation();
  const errorId = useId();
  const { draft, setDraft, conflict, reset } = useSettingDraft(
    String(override ?? ""),
  );
  const parsed = draft.trim() ? Number(draft) : undefined;
  const valid =
    parsed === undefined ||
    (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1_000_000);
  const commit = async () => {
    if (
      !conflict &&
      valid &&
      parsed !== override &&
      (await onChange(parsed)) === false
    )
      reset();
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
    <div className="settings-group flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium">
            {t("settings.maxOutputTokens", "Max Output Tokens")}
          </div>
        </div>
        {override !== undefined && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            {t("settings.useDefault", "Use default")}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("settings.maxOutputTokens", "Max Output Tokens")}
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
          className="h-10 min-w-0 flex-[1_1_11rem] rounded-md border border-border bg-background px-3 font-mono text-sm outline-none focus:ring-1 focus:ring-primary"
        />
        <span className="text-xs text-muted-foreground">
          {defaultValue === undefined
            ? t("settings.taskOutputDefault")
            : t("settings.parameterDefault", {
                value: defaultValue.toLocaleString(i18n.language),
              })}
        </span>
        {modelLimit === undefined && (
          <span className="text-xs text-muted-foreground">
            {t("settings.modelLimitsUnknown", {
              defaultValue: "Model limits unknown",
            })}
          </span>
        )}
        {modelLimit !== undefined && (
          <span className="text-xs text-muted-foreground">
            {t("settings.modelOutputLimit", {
              value: modelLimit.toLocaleString(i18n.language),
              defaultValue: "Reference model limit: {{value}}",
            })}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <ValueCell
          label={t("settings.effectiveOutputBudget", "Effective output budget")}
          value={effectiveOutput?.toLocaleString(i18n.language) ?? "—"}
        />
        <ValueCell
          label={t("settings.remainingInputBudget", "Remaining input budget")}
          value={inputBudget?.toLocaleString(i18n.language) ?? "—"}
        />
      </div>
      <SettingsHelp label={t("settings.tokenBudgetHelp")}>
        <p>{t("settings.maxOutputTokensHint")}</p>
        <p className="mt-1">{t("settings.tokenBudgetPreviewHint")}</p>
      </SettingsHelp>
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
          ? "min-w-0 rounded-md bg-primary/10 px-2.5 py-2"
          : "min-w-0 rounded-md bg-muted/45 px-2.5 py-2"
      }
    >
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-xs tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}
import { SettingsHelp } from "../pane-layout.js";
