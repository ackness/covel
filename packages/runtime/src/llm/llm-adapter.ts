/**
 * LLM adapter — thin abstraction for calling language models.
 *
 * The canonical definitions now live in `@covel/shared`
 * (`types/llm-adapter.ts`) so that distribution-only consumers such as
 * `@covel/create` can depend on the call contract without transitively
 * pulling in the entire kernel. This module re-exports them for backward
 * compatibility — every existing `from "@covel/runtime"` / `from
 * "./llm-adapter.js"` import keeps working unchanged.
 */

export type {
  LLMTextPart,
  LLMImagePart,
  LLMContentPart,
  LLMMessageContent,
  LLMMessage,
  LLMToolCall,
  LLMResponse,
  LLMToolDefinition,
  LLMResponseFormat,
  LLMStreamEvent,
  LLMTargetIdentity,
  LLMAdapter,
} from "@covel/shared";
