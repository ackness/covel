import { useTranslation } from "react-i18next";
import {
  SettingsDraftConflict,
  useSettingDraft,
} from "../use-setting-draft.js";

export function MaxOutputTokensCard({
  override,
  modelLimit,
  onChange,
}: {
  override: number | undefined;
  modelLimit?: number;
  onChange: (value: number | undefined) => void;
}) {
  const { t } = useTranslation();
  const { draft, setDraft, conflict, reset } = useSettingDraft(
    String(override ?? ""),
  );
  const parsed = draft.trim() ? Number(draft) : undefined;
  const valid =
    parsed === undefined ||
    (Number.isSafeInteger(parsed) &&
      parsed > 0 &&
      (modelLimit === undefined || parsed <= modelLimit));
  const commit = () => {
    if (!conflict && valid && parsed !== override) onChange(parsed);
  };
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
              "Caps one response. Leave unset to use the provider default.",
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
          value={t("settings.providerDefault", "Provider default")}
        />
        <ValueCell
          label={t("settings.currentValue", "Current")}
          value={
            override?.toLocaleString() ??
            t("settings.providerDefault", "Provider default")
          }
          active={override !== undefined}
        />
      </div>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
        <input
          aria-label={t("settings.maxOutputTokens", "Max output tokens")}
          type="number"
          min={1}
          max={modelLimit}
          step={1}
          placeholder={t("settings.numberPlaceholder", "e.g. 4096")}
          value={draft}
          aria-invalid={!valid}
          aria-describedby={!valid ? "max-output-error" : undefined}
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
              defaultValue: "Model limit: {{value}}",
            })}
          </span>
        )}
      </div>
      {!valid && (
        <p
          id="max-output-error"
          role="alert"
          className="text-xs text-destructive"
        >
          {t("settings.maxOutputTokensInvalid", {
            defaultValue:
              "Enter a positive whole number within the displayed limit.",
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
