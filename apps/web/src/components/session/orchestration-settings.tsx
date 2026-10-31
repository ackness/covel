import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OrchestrationResponse } from "@covel/shared";
import {
  getOrchestration,
  patchOrchestration,
} from "@/services/api/sessions.js";
import { getSessionWorkspace } from "@/services/data-service.js";

export function OrchestrationSettings({
  sessionId,
  disabled,
  refreshKey,
}: {
  sessionId: string;
  disabled?: boolean;
  refreshKey?: unknown;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<OrchestrationResponse>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    setValue(undefined);
    setError(false);
    void getOrchestration(sessionId).then(
      (result) => {
        if (live) setValue(result);
      },
      () => {
        if (live) setError(true);
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId, refreshKey]);
  const save = async (patch: Parameters<typeof patchOrchestration>[1]) => {
    setSaving(true);
    setError(false);
    try {
      setValue(
        await getSessionWorkspace().run(
          sessionId,
          `orchestration:${crypto.randomUUID()}`,
          () => patchOrchestration(sessionId, patch),
        ),
      );
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  if (!value)
    return error ? <p role="alert">{t("orchestration.error")}</p> : null;
  const selection = value.settings.turnPolicy;
  return (
    <fieldset
      disabled={disabled || saving}
      className="space-y-2 rounded border p-2 text-xs"
    >
      <legend>{t("orchestration.title")}</legend>
      <label className="flex items-center justify-between gap-2">
        {t("orchestration.policy")}
        <select
          aria-label={t("orchestration.policy")}
          value={selection ? JSON.stringify(selection) : ""}
          onChange={(event) => {
            const policy = value.policies.find(
              (item) =>
                JSON.stringify({ pluginId: item.pluginId, name: item.name }) ===
                event.target.value,
            );
            void save({
              turnPolicy: policy
                ? { pluginId: policy.pluginId, name: policy.name }
                : null,
            });
          }}
        >
          <option value="">{t("orchestration.automatic")}</option>
          {value.policies.map((policy) => (
            <option
              key={`${policy.pluginId}/${policy.name}`}
              value={JSON.stringify({
                pluginId: policy.pluginId,
                name: policy.name,
              })}
              disabled={policy.status === "unavailable"}
            >
              {policy.label}
              {policy.status !== "available"
                ? ` (${t(`orchestration.${policy.status}`)})`
                : ""}
            </option>
          ))}
        </select>
      </label>
      <p role="status">{t(`orchestration.${value.status}`)}</p>
      {(["maxActors", "maxSubagentCalls"] as const).map((key) => (
        <label key={key} className="flex items-center justify-between gap-2">
          {t(`orchestration.${key}`)}
          <input
            aria-label={t(`orchestration.${key}`)}
            type="number"
            min={0}
            max={key === "maxActors" ? 16 : 64}
            step={1}
            value={value.settings[key]}
            onChange={(event) => {
              const number = event.target.valueAsNumber;
              if (Number.isInteger(number) && event.target.validity.valid)
                void save({ [key]: number });
            }}
            className="w-16 rounded border px-1"
          />
        </label>
      ))}
      {error && <p role="alert">{t("orchestration.error")}</p>}
    </fieldset>
  );
}
