import { useTranslation } from "react-i18next";
import type {
  ReasoningEffort,
  ReasoningEffortProfile,
} from "@/services/api.js";
import { isReasoningEffortOverrideValid } from "./llm-reasoning-effort.js";
import { SettingsHelp } from "../pane-layout.js";

export function ReasoningEffortCard({
  profile,
  override,
  defaultOverride,
  onChange,
  scope = "slot",
}: {
  scope?: "model" | "slot";
  profile: ReasoningEffortProfile | null | undefined;
  override: ReasoningEffort | undefined;
  defaultOverride?: ReasoningEffort;
  onChange: (value: ReasoningEffort | undefined) => void;
}) {
  const { t } = useTranslation();
  const defaultValue = defaultOverride;
  const validOverride = isReasoningEffortOverrideValid(profile, override)
    ? override
    : undefined;
  const effective = validOverride ?? defaultValue;
  const unsupported = override !== undefined && validOverride === undefined;
  const missingOption =
    override !== undefined &&
    override !== "provider-default" &&
    !profile?.options.some((option) => option.value === override);
  const effortHint = profile
    ? t("settings.reasoningEffortHint", {
        family: t(`settings.reasoningFamily.${profile.family}`),
      })
    : t("settings.reasoningUnavailable");
  const displayValue = (value: ReasoningEffort | undefined) =>
    value
      ? `${t(`settings.reasoningLevel.${value}`)}${budgetLabel(value)}`
      : t("settings.reasoningTaskDefault");
  const budgetLabel = (value: ReasoningEffort) => {
    const budget = profile?.options.find(
      (option) => option.value === value,
    )?.thinkingBudgetTokens;
    return budget === undefined
      ? ""
      : ` · ${t("settings.reasoningBudget", { count: budget })}`;
  };

  return (
    <div
      className={
        scope === "model"
          ? "space-y-2"
          : "space-y-3 border border-border p-3 md:col-span-2"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">
            {t(
              scope === "model"
                ? "settings.modelReasoningDefault"
                : "settings.reasoningEffort",
            )}
          </div>
          <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {scope === "model" ? (
              <SettingsHelp>
                <p>{effortHint}</p>
                <p className="mt-1">{t("settings.modelReasoningReuseHint")}</p>
              </SettingsHelp>
            ) : (
              <p>{effortHint}</p>
            )}
          </div>
        </div>
        {override !== undefined && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="shrink-0 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("settings.useDefault")}
          </button>
        )}
      </div>
      {scope === "slot" && (
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <ReasoningValueCell
            label={t("settings.reasoningInheritedValue")}
            value={displayValue(defaultValue)}
          />
          <ReasoningValueCell
            label={t(
              validOverride !== undefined
                ? "settings.reasoningExplicitValue"
                : "settings.reasoningCurrentValue",
            )}
            value={displayValue(effective)}
            active={validOverride !== undefined}
          />
        </div>
      )}
      <select
        aria-label={t("settings.reasoningEffort")}
        value={override ?? ""}
        onChange={(event) =>
          onChange(
            (event.target.value || undefined) as ReasoningEffort | undefined,
          )
        }
        className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="">
          {t(
            scope === "model"
              ? "settings.reasoningTaskDefault"
              : "settings.reasoningInherit",
          )}
        </option>
        <option value="provider-default">
          {t("settings.providerDefault")}
        </option>
        {missingOption && (
          <option value={override} disabled>
            {displayValue(override)}
          </option>
        )}
        {profile?.options.map((option) => (
          <option key={option.value} value={option.value}>
            {t(`settings.reasoningLevel.${option.value}`)}
            {option.thinkingBudgetTokens !== undefined
              ? budgetLabel(option.value)
              : option.value !== "automatic" && option.value !== "disabled"
                ? ` (${option.value})`
                : ""}
          </option>
        ))}
      </select>
      {profile?.options.some(
        (option) => option.thinkingBudgetTokens !== undefined,
      ) && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {t("settings.reasoningBudgetHint")}
        </p>
      )}
      {unsupported && (
        <p role="alert" className="text-xs text-(--accent-warning)">
          {t("settings.reasoningUnsupported")}
        </p>
      )}
      {scope === "slot" && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {t("settings.reasoningPrecedenceHint")}
        </p>
      )}
      {profile?.requestDefault &&
        profile.defaultValue &&
        effective === undefined && (
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {t("settings.reasoningRequestDefaultHint", {
              level: t(`settings.reasoningLevel.${profile.requestDefault}`),
              defaultLevel: t(
                `settings.reasoningLevel.${profile.defaultValue}`,
              ),
            })}
          </p>
        )}
      {profile?.sampling?.ignoredWhileThinking &&
        effective !== "disabled" &&
        effective !== "none" && (
          <p className="border-l-2 border-(--accent-warning)/60 pl-2 text-[10px] leading-relaxed text-muted-foreground">
            {t("settings.reasoningSamplingIgnoredHint")}
          </p>
        )}
      {profile?.sampling?.fixed?.length ? (
        <p className="border-l-2 border-(--accent-warning)/60 pl-2 text-[10px] leading-relaxed text-muted-foreground">
          {t("settings.reasoningSamplingFixedHint", {
            parameters: profile.sampling.fixed
              .map((name) => t(`settings.samplingParameter.${name}`))
              .join(", "),
          })}
        </p>
      ) : null}
    </div>
  );
}

function ReasoningValueCell({
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
