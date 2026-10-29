import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  normalizeTrustedSources,
  trustedSourceEntrySchema,
  TRUSTED_SOURCES_SETTING_KEY,
} from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import {
  useSetting,
  useServerSettingState,
  useSettingsStore,
} from "../use-settings.js";
import { SUGGESTED_PLUGIN_REPOSITORY } from "./package-suggestions.js";

export function TrustedSourcesCard() {
  const { t } = useTranslation();
  const [entries] = useSetting<string[]>(TRUSTED_SOURCES_SETTING_KEY);
  const state = useServerSettingState(TRUSTED_SOURCES_SETTING_KEY);
  const store = useSettingsStore();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const locked = state?.status !== "ready" || !state.settable || saving;
  const reason =
    state?.status === "ready"
      ? state.settable
        ? null
        : t(
            state.source === "env"
              ? "settings.serverSetting.fixedByDeployment"
              : "settings.serverSetting.operatorOnly",
          )
      : t(
          state?.status === "unavailable"
            ? "settings.serverSetting.unavailable"
            : "settings.serverSetting.pending",
        );
  async function save(next: string[]) {
    setSaving(true);
    setError(null);
    try {
      await store.set(
        TRUSTED_SOURCES_SETTING_KEY,
        normalizeTrustedSources(next),
      );
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="space-y-3 rounded border border-border p-3">
      <h3 className="text-sm font-semibold">
        {t("settings.trustedSources.title")}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t("settings.trustedSources.explanation")}
      </p>
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      <ul className="space-y-1 text-xs">
        {(entries ?? []).map((entry) => (
          <li key={entry} className="flex items-center justify-between gap-2">
            <span>{entry}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              aria-label={t("settings.trustedSources.removeEntry", { entry })}
              onClick={() =>
                void save((entries ?? []).filter((value) => value !== entry))
              }
            >
              {t("settings.trustedSources.remove")}
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (locked) return;
          const parsed = trustedSourceEntrySchema.safeParse(input);
          if (!parsed.success || (entries ?? []).length >= 100) {
            setError(t("settings.trustedSources.invalid"));
            return;
          }
          void save([...(entries ?? []), parsed.data]);
        }}
      >
        <label
          className="min-w-0 flex-1 text-xs"
          htmlFor="trusted-source-entry"
        >
          {t("settings.trustedSources.entry")}
          <input
            id="trusted-source-entry"
            value={input}
            disabled={locked}
            onChange={(event) => {
              setInput(event.target.value);
              setError(null);
            }}
            className="mt-1 w-full rounded border border-border bg-transparent p-2 text-sm"
            aria-invalid={!!error}
            aria-describedby={error ? "trusted-source-error" : undefined}
          />
        </label>
        <Button size="sm" type="submit" disabled={locked || !input.trim()}>
          {t("settings.trustedSources.add")}
        </Button>
      </form>
      <Button
        size="sm"
        variant="outline"
        disabled={locked}
        onClick={() => {
          setInput(SUGGESTED_PLUGIN_REPOSITORY);
          setError(null);
        }}
      >
        {t("settings.trustedSources.suggest")}
      </Button>
      {error && (
        <p
          id="trusted-source-error"
          role="alert"
          className="text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </section>
  );
}
