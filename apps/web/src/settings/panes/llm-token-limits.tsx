import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { ModelCapabilityInfo } from "@/services/api.js";
import {
  SettingsDraftConflict,
  useSettingDraft,
} from "../use-setting-draft.js";

/** Shared by capability editing and generation settings; writes the same overrides. */
export function ModelTokenLimits({
  capability,
  override,
  onUpdate,
}: {
  capability?: ModelCapabilityInfo;
  override?: Partial<ModelCapabilityInfo>;
  onUpdate: (patch: Partial<ModelCapabilityInfo>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:col-span-2">
      <TokenLimit
        label={t("settings.contextWindowTokens", "Context Window (tokens)")}
        hint={t(
          "settings.contextWindowHint",
          "Total context budget, including input and reserved output. Leave blank to use the model configuration.",
        )}
        placeholder={capability?.contextWindow?.toString() ?? "e.g. 131072"}
        value={override?.contextWindow}
        max={10_000_000}
        onChange={(contextWindow) => onUpdate({ contextWindow })}
      />
      <TokenLimit
        label={t(
          "settings.modelMaxOutputTokens",
          "Model output capacity (tokens)",
        )}
        hint={t(
          "settings.modelMaxOutputTokensHint",
          "The provider's output ceiling, not the amount requested each time. Override incorrect catalog limits here.",
        )}
        placeholder={capability?.maxOutputTokens?.toString() ?? "e.g. 8192"}
        value={override?.maxOutputTokens}
        max={1_000_000}
        onChange={(maxOutputTokens) => onUpdate({ maxOutputTokens })}
      />
    </div>
  );
}

function TokenLimit({
  label,
  hint,
  placeholder,
  value,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value?: number;
  max: number;
  onChange: (value: number | undefined) => void;
}) {
  const id = useId();
  const { t } = useTranslation();
  const { draft, setDraft, conflict, reset } = useSettingDraft(
    String(value ?? ""),
  );
  const parsed = draft.trim() ? Number(draft) : undefined;
  const valid =
    parsed === undefined ||
    (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max);
  return (
    <div className="space-y-2 border border-border p-3">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <p id={`${id}-hint`} className="text-[10px] text-muted-foreground">
        {hint}
      </p>
      <input
        id={id}
        type="number"
        min={1}
        max={max}
        step={1}
        placeholder={placeholder}
        value={draft}
        aria-invalid={!valid}
        aria-describedby={valid ? `${id}-hint` : `${id}-hint ${id}-error`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!conflict && valid && parsed !== value) onChange(parsed);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="w-full border border-border bg-background px-2 py-1 text-xs font-mono outline-none focus:ring-1 focus:ring-primary"
      />
      {!valid && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {t("settings.tokenLimitInvalid", {
            max: max.toLocaleString(),
            defaultValue: "Enter a whole number between 1 and {{max}}.",
          })}
        </p>
      )}
      {conflict && <SettingsDraftConflict onReload={reset} />}
    </div>
  );
}
