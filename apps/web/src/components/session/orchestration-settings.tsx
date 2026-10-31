import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  autoAdvanceLimitSchema,
  orchestrationSettingsPatchSchema,
  type OrchestrationResponse,
} from "@covel/shared";
import {
  getOrchestration,
  patchOrchestration,
} from "@/services/api/sessions.js";
import {
  getDataService,
  getSessionWorkspace,
} from "@/services/data-service.js";
import { SettingsDialog } from "@/settings/SettingsDialog.js";

const caps = {
  maxActors: orchestrationSettingsPatchSchema.shape.maxActors.unwrap(),
  maxSubagentCalls:
    orchestrationSettingsPatchSchema.shape.maxSubagentCalls.unwrap(),
  autoAdvanceLimit: autoAdvanceLimitSchema,
};
type Field = "turnPolicy" | keyof typeof caps;
type Fields<T> = Partial<Record<Field, T>>;
const selectionValue = (
  selection: OrchestrationResponse["settings"]["turnPolicy"],
) =>
  selection
    ? JSON.stringify({ pluginId: selection.pluginId, name: selection.name })
    : "";

const loadResources = (sessionId: string) =>
  Promise.allSettled([
    Promise.resolve().then(() => getOrchestration(sessionId)),
    Promise.resolve().then(() => getDataService().getSession(sessionId)),
  ]);

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
  const [draft, setDraft] = useState<Fields<string>>({});
  const [saved, setSaved] = useState<Fields<string>>({});
  const [pending, setPending] = useState<Fields<boolean>>({});
  const [errors, setErrors] = useState<Fields<boolean>>({});
  const [loadError, setLoadError] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const generation = useRef(0),
    refresh = useRef(0);
  const revisions = useRef<Fields<number>>({});
  const owner = useRef(sessionId);
  const savedRef = useRef(saved),
    pendingRef = useRef(pending);
  owner.current = sessionId;
  savedRef.current = saved;
  pendingRef.current = pending;
  useEffect(() => {
    const current = ++generation.current;
    revisions.current = {};
    setValue(undefined);
    setDraft({});
    setSaved({});
    setErrors({});
    setPending({});
    setLoadError(false);
    setSettingsOpen(false);
    void loadResources(sessionId).then(([orchestration, session]) => {
      if (generation.current !== current || owner.current !== sessionId) return;
      const fields: Fields<string> = {};
      if (orchestration.status === "fulfilled" && orchestration.value) {
        setValue(orchestration.value);
        fields.turnPolicy = selectionValue(
          orchestration.value.settings.turnPolicy,
        );
        fields.maxActors = String(orchestration.value.settings.maxActors);
        fields.maxSubagentCalls = String(
          orchestration.value.settings.maxSubagentCalls,
        );
      } else setLoadError(true);
      if (session.status === "fulfilled" && session.value)
        fields.autoAdvanceLimit = String(session.value.autoAdvanceLimit);
      else setLoadError(true);
      setSaved(fields);
      setDraft(fields);
    });
    return () => {
      generation.current++;
    };
  }, [sessionId, refreshKey]);
  const label = (field: Field) =>
    t(
      field === "autoAdvanceLimit"
        ? "session.autoAdvanceLimit"
        : `orchestration.${field === "turnPolicy" ? "policy" : field}`,
    );
  const edit = (field: Field, text: string) => {
    revisions.current[field] = (revisions.current[field] ?? 0) + 1;
    setDraft((previous) => ({ ...previous, [field]: text }));
    setErrors((previous) => ({ ...previous, [field]: false }));
  };
  const save = async (field: Field, text = draft[field]) => {
    if (text === undefined) return;
    const current = generation.current,
      revision = revisions.current[field] ?? 0;
    const live = () =>
      generation.current === current && owner.current === sessionId;
    const numeric =
      field === "turnPolicy"
        ? undefined
        : caps[field].safeParse(text.trim() === "" ? NaN : Number(text));
    if (numeric && !numeric.success) {
      setErrors((previous) => ({ ...previous, [field]: true }));
      return;
    }
    setPending((previous) => ({ ...previous, [field]: true }));
    setErrors((previous) => ({ ...previous, [field]: false }));
    try {
      let confirmed: string;
      if (field === "autoAdvanceLimit" && numeric?.success) {
        const updated = await getDataService().updateSession(sessionId, {
          autoAdvanceLimit: numeric.data,
        });
        confirmed = String(updated.autoAdvanceLimit);
      } else {
        const policy = value?.policies.find(
          (item) => selectionValue(item) === text,
        );
        const patch =
          field === "turnPolicy"
            ? {
                turnPolicy: policy
                  ? { pluginId: policy.pluginId, name: policy.name }
                  : null,
              }
            : { [field]: numeric?.success ? numeric.data : undefined };
        const updated = await getSessionWorkspace().run(
          sessionId,
          `orchestration:${crypto.randomUUID()}`,
          () => patchOrchestration(sessionId, patch),
        );
        confirmed =
          field === "turnPolicy"
            ? selectionValue(updated.settings.turnPolicy)
            : String(
                updated.settings[field as "maxActors" | "maxSubagentCalls"],
              );
      }
      if (!live()) return;
      setSaved((previous) => ({ ...previous, [field]: confirmed }));
      if ((revisions.current[field] ?? 0) === revision)
        setDraft((previous) => ({ ...previous, [field]: confirmed }));
    } catch {
      if (live()) setErrors((previous) => ({ ...previous, [field]: true }));
    }
    if (live()) {
      // Refresh both saved resources even after a failure; preserve every unsaved draft.
      const sequence = ++refresh.current;
      const [orchestration, session] = await loadResources(sessionId);
      if (live()) {
        if (sequence === refresh.current) {
          const authoritative: Fields<string> = {};
          if (orchestration.status === "fulfilled" && orchestration.value) {
            setValue(orchestration.value);
            authoritative.turnPolicy = selectionValue(
              orchestration.value.settings.turnPolicy,
            );
            authoritative.maxActors = String(
              orchestration.value.settings.maxActors,
            );
            authoritative.maxSubagentCalls = String(
              orchestration.value.settings.maxSubagentCalls,
            );
          }
          if (session.status === "fulfilled" && session.value)
            authoritative.autoAdvanceLimit = String(
              session.value.autoAdvanceLimit,
            );
          const previousSaved = savedRef.current;
          setDraft((previous) => {
            const next = { ...previous };
            for (const key of Object.keys(authoritative) as Field[]) {
              if (
                previous[key] === previousSaved[key] &&
                (!pendingRef.current[key] || key === field)
              )
                next[key] = authoritative[key];
            }
            return next;
          });
          setSaved((previous) => ({ ...previous, ...authoritative }));
        }
        setLoadError(
          orchestration.status === "rejected" || session.status === "rejected",
        );
        setPending((previous) => ({ ...previous, [field]: false }));
      }
    }
  };
  const activePolicies =
    value?.policies.filter((policy) => policy.status !== "unavailable") ?? [];
  const selected =
    value?.settings.turnPolicy ??
    (activePolicies.length === 1 ? activePolicies[0] : undefined);
  const provider = value?.policies.find(
    (policy) => selectionValue(policy) === selectionValue(selected),
  );
  const multipleProviders = activePolicies.length > 1;
  const button = (field: Field) => (
    <button
      type="button"
      disabled={
        disabled ||
        pending[field] ||
        draft[field] === undefined ||
        draft[field] === saved[field]
      }
      onClick={() => void save(field)}
      aria-label={t("orchestration.saveField", { field: label(field) })}
    >
      {t(pending[field] ? "orchestration.saving" : "orchestration.save")}
    </button>
  );
  if (!value && saved.autoAdvanceLimit === undefined) return null;
  return (
    <fieldset className="space-y-3 rounded border border-(--rule-color) p-3 text-xs">
      <legend>{t("orchestration.title")}</legend>
      {multipleProviders ? (
        <>
          <label htmlFor={`${sessionId}-policy`}>{label("turnPolicy")}</label>
          <div className="flex items-center gap-2">
            <select
              id={`${sessionId}-policy`}
              disabled={disabled || !value || pending.turnPolicy}
              value={draft.turnPolicy ?? ""}
              aria-describedby={
                errors.turnPolicy ? `${sessionId}-turnPolicy-error` : undefined
              }
              onChange={(event) => edit("turnPolicy", event.target.value)}
            >
              <option value="">{t("orchestration.automatic")}</option>
              {value?.policies.map((policy) => (
                <option
                  key={selectionValue(policy)}
                  value={selectionValue(policy)}
                  disabled={policy.status === "unavailable"}
                >
                  {policy.label}
                  {policy.status !== "available"
                    ? ` (${t(`orchestration.${policy.status}`)})`
                    : ""}
                </option>
              ))}
            </select>
            {button("turnPolicy")}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <p>
            {label("turnPolicy")}:{" "}
            <span>{provider?.label ?? t("orchestration.automatic")}</span>
          </p>
          {value?.settings.turnPolicy && (
            <button
              type="button"
              disabled={disabled || pending.turnPolicy}
              onClick={() => void save("turnPolicy", "")}
            >
              {t("orchestration.clearPolicy")}
            </button>
          )}
        </div>
      )}
      <p>{t(`orchestration.${value?.status ?? "unavailable"}`)}</p>
      {provider && provider.status !== "unavailable" && (
        <button
          type="button"
          className="underline"
          onClick={() => setSettingsOpen(true)}
        >
          {t("orchestration.providerSettings", { provider: provider.label })}
        </button>
      )}
      {(Object.keys(caps) as (keyof typeof caps)[]).map((field) => (
        <div key={field}>
          <label htmlFor={`${sessionId}-${field}`}>{label(field)}</label>
          <div className="flex items-center gap-2">
            <input
              id={`${sessionId}-${field}`}
              type="number"
              min={caps[field].minValue ?? undefined}
              max={caps[field].maxValue ?? undefined}
              step={1}
              value={draft[field] ?? ""}
              disabled={
                disabled || pending[field] || saved[field] === undefined
              }
              onChange={(event) => edit(field, event.target.value)}
              aria-invalid={errors[field] || undefined}
              aria-describedby={
                errors[field] ? `${sessionId}-${field}-error` : undefined
              }
              className="w-20 rounded border px-2 py-1"
            />
            {button(field)}
          </div>
          {errors[field] && (
            <p id={`${sessionId}-${field}-error`} role="alert">
              {t("orchestration.fieldError")}
            </p>
          )}
        </div>
      ))}
      {errors.turnPolicy && (
        <p id={`${sessionId}-turnPolicy-error`} role="alert">
          {t("orchestration.fieldError")}
        </p>
      )}
      {loadError && <p role="alert">{t("orchestration.error")}</p>}
      <p>{t("orchestration.capScope")}</p>
      <p>{t("session.autoAdvanceNextInput")}</p>
      {provider && (
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          initialKey={`plugin.${provider.pluginId}`}
          plugins={[{ id: provider.pluginId, displayName: provider.label }]}
        />
      )}
    </fieldset>
  );
}
