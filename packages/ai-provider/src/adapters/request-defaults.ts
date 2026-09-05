import type { LLMRequestDefaults } from "@covel/shared";
import { resolveReasoningEffortProfile } from "../reasoning-effort.js";
import type { TextGenerationParams } from "../types.js";

/** User slot/preset metadata and parameter overrides always beat runtime defaults. */
export function withTextRequestDefaults(
  params: TextGenerationParams,
): TextGenerationParams {
  const metadata = params.providerRequestMetadata;
  const overrides = metadata?.parameterOverrides;
  const hasOverride =
    overrides !== null &&
    typeof overrides === "object" &&
    "reasoningEffort" in overrides;
  const hasReasoning =
    hasOverride ||
    [
      "reasoningEffort",
      "reasoning_effort",
      "enable_thinking",
      "thinking",
      "reasoning",
      "output_config",
    ].some((key) => metadata?.[key] !== undefined);
  if (!params.defaults?.reasoningEffort || hasReasoning) return params;
  const profile = resolveReasoningEffortProfile(params.model);
  const selection = profile?.options.some((option) => option.value === "none")
    ? "none"
    : params.defaults.reasoningEffort;
  return {
    ...params,
    providerRequestMetadata: {
      ...metadata,
      reasoningEffort: selection,
    },
  };
}

/**
 * Qwen and Anthropic thinking only support automatic tool selection. Preserve
 * explicit reasoning settings instead of sending an incompatible forced call.
 * https://help.aliyun.com/en/model-studio/qwen-function-calling
 */
export function defaultToolChoice(
  defaults: LLMRequestDefaults | undefined,
  body: Record<string, unknown>,
  protocol: "chat" | "responses" | "anthropic",
): unknown {
  const thinking = body.thinking;
  const thinkingEnabled =
    body.enable_thinking === true ||
    (thinking !== null &&
      typeof thinking === "object" &&
      "type" in thinking &&
      (thinking.type === "enabled" || thinking.type === "adaptive"));
  const name = thinkingEnabled ? undefined : defaults?.toolChoice?.name;
  if (protocol === "anthropic") {
    return name ? { type: "tool", name } : { type: "auto" };
  }
  if (!name) return "auto";
  return protocol === "chat"
    ? { type: "function", function: { name } }
    : { type: "function", name };
}
