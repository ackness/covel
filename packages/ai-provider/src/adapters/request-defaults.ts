import type { ModelRequestContext, ProviderProtocol } from "../types.js";
import type { LLMRequestDefaults } from "@covel/shared";
import {
  readReasoningEffort,
  resolveReasoningEffortProfile,
} from "../reasoning-effort.js";
import type { TextGenerationParams } from "../types.js";

/** User slot/preset metadata and parameter overrides always beat runtime defaults. */
export function withTextRequestDefaults(
  params: TextGenerationParams,
  context?: ModelRequestContext,
  protocol?: ProviderProtocol,
  warn?: (message: string) => void,
): TextGenerationParams {
  const metadata = params.providerRequestMetadata;
  const overrides = metadata?.parameterOverrides;
  if (readReasoningEffort(metadata) === "provider-default") {
    // Provider defaults may enable thinking, which can reject forced tools.
    return { ...params, defaults: undefined };
  }
  const hasOverride =
    overrides !== null &&
    typeof overrides === "object" &&
    "reasoningEffort" in overrides;
  const hasReasoning =
    hasOverride ||
    (metadata?.generationConfig !== null &&
      typeof metadata?.generationConfig === "object" &&
      "thinkingConfig" in metadata.generationConfig) ||
    [
      "reasoningEffort",
      "reasoning_effort",
      "enable_thinking",
      "thinking_budget",
      "thinking",
      "thinkingConfig",
      "reasoning",
      "output_config",
    ].some((key) => metadata?.[key] !== undefined);
  if (!params.defaults?.reasoningEffort || hasReasoning) return params;
  const profile = resolveReasoningEffortProfile(
    params.model,
    context?.preset?.provider ?? context?.profile?.provider,
    protocol,
  );
  if (!profile) {
    warn?.(
      `Reasoning controls for ${params.model} are unknown; the runtime default was omitted.`,
    );
    return params;
  }
  const defaultSelection =
    profile.options.find(
      (option) => option.value === "none" || option.value === "disabled",
    )?.value ?? profile.options[0]?.value;
  if (!defaultSelection) return params;
  if (defaultSelection !== "none" && defaultSelection !== "disabled")
    warn?.(
      `${params.model} cannot disable thinking; using its lowest supported setting (${defaultSelection}).`,
    );
  return {
    ...params,
    providerRequestMetadata: {
      ...metadata,
      reasoningEffort: defaultSelection,
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
  const choice = thinkingEnabled ? undefined : defaults?.toolChoice;
  if (choice === "required")
    return protocol === "anthropic" ? { type: "any" } : "required";
  const name = choice?.name;
  if (protocol === "anthropic") {
    return name ? { type: "tool", name } : { type: "auto" };
  }
  if (!name) return "auto";
  return protocol === "chat"
    ? { type: "function", function: { name } }
    : { type: "function", name };
}
