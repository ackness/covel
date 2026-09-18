import { useTranslation } from "react-i18next";
import type { ReasoningEffort } from "@/services/api.js";
import { useModelCapability } from "./use-model-capability.js";
import { ReasoningEffortCard } from "./llm-reasoning-effort-card.js";
import { parseModelIds } from "./llm-provider-catalog.js";

export function ModelReasoningSettings({
  model,
  provider,
  protocol,
  value,
  onChange,
}: {
  model: string;
  provider: string;
  protocol?: string;
  value?: ReasoningEffort;
  onChange: (value: ReasoningEffort | undefined) => void;
}) {
  const lookup = useModelCapability(model, provider, protocol);
  return (
    <fieldset aria-label={model} className="min-w-0">
      <ReasoningEffortCard
        scope="model"
        profile={lookup?.reasoning}
        override={value}
        onChange={onChange}
      />
    </fieldset>
  );
}

/** Each imported model owns its defaults; a batch never shares an effort. */
export function ImportedModelReasoning({
  modelIds,
  provider,
  protocol,
  values,
  onChange,
}: {
  modelIds: string;
  provider: string;
  protocol?: string;
  values: Record<string, ReasoningEffort | undefined>;
  onChange: (values: Record<string, ReasoningEffort | undefined>) => void;
}) {
  const { t } = useTranslation();
  const models = parseModelIds(modelIds);
  if (!models.length) return null;
  return (
    <details className="border border-border p-3">
      <summary className="cursor-pointer text-xs font-medium">
        {t("settings.modelReasoningDefault")}
      </summary>
      <div className="mt-3 max-h-72 space-y-3 overflow-y-auto">
        {models.map((model) => (
          <div key={model} className="space-y-1">
            <div className="break-all font-mono text-xs">{model}</div>
            <ModelReasoningSettings
              model={model}
              provider={provider}
              protocol={protocol}
              value={values[model]}
              onChange={(value) => onChange({ ...values, [model]: value })}
            />
          </div>
        ))}
      </div>
    </details>
  );
}
