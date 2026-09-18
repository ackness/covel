import i18n from "@/i18n/index.js";
import type { ReasoningEffort } from "@covel/shared";

/** Display identity only. Requests and capability lookup must use the API model ID. */
export function formatModelConfigLabel(config: {
  name?: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  parameterOverrides?: { reasoningEffort?: ReasoningEffort };
}): string {
  const name = config.name?.trim() || config.model;
  const effort =
    config.reasoningEffort ?? config.parameterOverrides?.reasoningEffort;
  return effort
    ? `${name} · ${i18n.t(`settings.reasoningLevel.${effort}`)}`
    : name;
}
