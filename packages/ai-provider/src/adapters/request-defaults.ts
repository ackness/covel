import type { ModelRequestContext, ProviderProtocol } from "../types.js";
import type { LLMRequestDefaults } from "@covel/shared";
import type { ReasoningControls } from "../capability/reasoning-models.js";
import {
  readReasoningEffort,
  resolveReasoningEffortProfile,
  thinksOnRequest,
} from "../reasoning-effort.js";
import type { TextGenerationParams } from "../types.js";

/**
 * Fill in the reasoning level when the player chose none: the runtime's
 * default first, then the model's `requestDefault` for a model whose own
 * default is costly. User slot/preset metadata and parameter overrides
 * always win.
 */
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
  if (hasReasoning) return params;
  const profile = resolveReasoningEffortProfile(
    context?.preset?.model ?? context?.profile?.model ?? params.model,
    context?.preset?.provider ?? context?.profile?.provider,
    protocol,
    undefined,
    context?.preset?.baseUrl,
  );
  if (!params.defaults?.reasoningEffort) {
    const level = profile?.requestDefault;
    if (!level || !profile.options.some((option) => option.value === level))
      return params;
    return {
      ...params,
      providerRequestMetadata: { ...metadata, reasoningEffort: level },
    };
  }
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
 * The runtime's tool choice, narrowed to what the target accepts while it
 * thinks. Many models (Qwen, Anthropic, DeepSeek) take only automatic choice
 * then; some (Kimi) also take `required` but not a named tool. Whether the
 * target thinks comes from the body, or from the model's default when the
 * body says nothing; the choices come from the reasoning model data.
 * https://help.aliyun.com/en/model-studio/qwen-function-calling
 */
export function defaultToolChoice(
  defaults: LLMRequestDefaults | undefined,
  body: Record<string, unknown>,
  protocol: "chat" | "responses" | "anthropic",
  controls?: Pick<
    ReasoningControls,
    "thinksByDefault" | "toolChoiceWhileThinking"
  >,
): unknown {
  let choice = defaults?.toolChoice;
  if (
    choice &&
    thinksOnRequest(body, {
      thinksByDefault: controls?.thinksByDefault ?? false,
    })
  ) {
    const accepted = controls?.toolChoiceWhileThinking ?? ["auto"];
    const kind = choice === "required" ? "required" : "named";
    if (!accepted.includes(kind))
      choice =
        kind === "named" && accepted.includes("required")
          ? "required"
          : undefined;
  }
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
