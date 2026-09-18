import { useTranslation } from "react-i18next";
import type {
  ReasoningEffort,
  ReasoningEffortProfile,
} from "@/services/api.js";
import { isReasoningEffortOverrideValid } from "./llm-reasoning-effort.js";

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
  const displayValue = (value: ReasoningEffort | undefined) =>
    value
      ? t(`settings.reasoningLevel.${value}`)
      : t("settings.reasoningTaskDefault");

  return (
    <div className="space-y-3 border border-border p-3 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">
            {t(
              scope === "model"
                ? "settings.modelReasoningDefault"
                : "settings.reasoningEffort",
            )}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {profile
              ? t("settings.reasoningEffortHint", {
                  family: t(`settings.reasoningFamily.${profile.family}`),
                })
              : t("settings.reasoningUnavailable")}
          </p>
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
        className="w-full border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
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
            {option.value !== "automatic" && option.value !== "disabled"
              ? ` (${option.value})`
              : ""}
          </option>
        ))}
      </select>
      {unsupported && (
        <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">
          {t("settings.reasoningUnsupported")}
        </p>
      )}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {t(
          scope === "model"
            ? "settings.modelReasoningReuseHint"
            : "settings.reasoningPrecedenceHint",
        )}
      </p>
      {profile?.family === "deepseek" && effective !== "disabled" && (
        <p className="border-l-2 border-amber-500/60 pl-2 text-[10px] leading-relaxed text-muted-foreground">
          {t("settings.deepseekReasoningSamplingHint")}
        </p>
      )}
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
