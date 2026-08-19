import { useTranslation } from "react-i18next";
import type {
  ReasoningEffort,
  ReasoningEffortProfile,
} from "@/services/api.js";
import { isReasoningEffortOverrideValid } from "./llm-reasoning-effort.js";

export function ReasoningEffortCard({
  profile,
  override,
  onChange,
}: {
  profile: ReasoningEffortProfile | null | undefined;
  override: ReasoningEffort | undefined;
  onChange: (value: ReasoningEffort | undefined) => void;
}) {
  const { t } = useTranslation();
  const defaultValue = profile?.defaultValue;
  const validOverride = isReasoningEffortOverrideValid(profile, override)
    ? override
    : undefined;
  const effective = validOverride ?? defaultValue;
  const displayValue = (value: ReasoningEffort | undefined) =>
    value
      ? t(`settings.reasoningLevel.${value}`)
      : t("settings.providerDefault");

  return (
    <div className="space-y-3 border border-border p-3 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">
            {t("settings.reasoningEffort")}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {profile
              ? t("settings.reasoningEffortHint", {
                  family: t(`settings.reasoningFamily.${profile.family}`),
                })
              : t("settings.reasoningUnavailable")}
          </p>
        </div>
        {validOverride !== undefined && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="shrink-0 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("settings.useDefault")}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <ReasoningValueCell
          label={t("settings.defaultValue")}
          value={displayValue(defaultValue)}
        />
        <ReasoningValueCell
          label={t("settings.currentValue")}
          value={displayValue(effective)}
          active={validOverride !== undefined}
        />
      </div>
      <select
        aria-label={t("settings.reasoningEffort")}
        value={validOverride ?? ""}
        disabled={!profile}
        onChange={(event) =>
          onChange(
            (event.target.value || undefined) as ReasoningEffort | undefined,
          )
        }
        className="w-full border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="">{t("settings.providerDefault")}</option>
        {profile?.options.map((option) => (
          <option key={option.value} value={option.value}>
            {t(`settings.reasoningLevel.${option.value}`)} ({option.value})
          </option>
        ))}
      </select>
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
