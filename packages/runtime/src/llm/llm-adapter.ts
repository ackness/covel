/**
 * LLM adapter — thin abstraction for calling language models.
 *
 * Runtime consumers share the call contract defined by `@covel/shared`.
 * Content-part types are imported directly from the shared package.
 */

export type {
  LLMMessageContent,
  LLMMessage,
  LLMToolCall,
  LLMUsageSummary,
  LLMResponse,
  LLMToolDefinition,
  LLMResponseFormat,
  LLMRequestDefaults,
  LLMStreamEvent,
  LLMTargetIdentity,
  LLMAdapter,
} from "@covel/shared";
