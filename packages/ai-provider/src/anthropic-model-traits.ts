/**
 * What a Claude model accepts in a Messages request, read from its model ID.
 * The rules are the ones in Anthropic's API reference; the request builder and
 * the reasoning profile both read them here, so one model cannot be treated
 * two ways. A model the patterns do not name keeps the general behaviour.
 */
export interface AnthropicModelTraits {
  /** `tool_choice` may be `any` or `tool`. */
  readonly forcedToolChoice: boolean;
  /** `thinking: { type: "disabled" }` is accepted. */
  readonly thinkingCanBeDisabled: boolean;
}

// Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5 and Claude Sonnet 5.5
// answer `tool_choice` `any` or `tool` with a 400. `auto` and `none` remain.
const NO_FORCED_TOOL_CHOICE =
  /claude-(?:(?:opus|sonnet)-5[.-]5|(?:fable|mythos)-5[.-]1)(?:-|$)/;

// Thinking is always on for the Fable and Mythos models, Claude Opus 5.5 and
// Claude Sonnet 5.5: they answer `thinking: { type: "disabled" }` with a 400.
const THINKING_ALWAYS_ON =
  /claude-(?:(?:fable|mythos)-5|(?:opus|sonnet)-5[.-]5)(?:[-.]|$)/;

export function anthropicModelTraits(modelId: string): AnthropicModelTraits {
  const model = modelId.toLowerCase();
  return {
    forcedToolChoice: !NO_FORCED_TOOL_CHOICE.test(model),
    thinkingCanBeDisabled: !THINKING_ALWAYS_ON.test(model),
  };
}
