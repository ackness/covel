import type { RuntimeContextView } from "@covel/shared";
import type {
  StreamEvent,
  TextGenerationResult,
  TextMessage,
  ToolDefinition,
  GatewayOptions,
} from "@covel/ai-provider";

import { buildPrompt, type PromptBuilderOptions } from "./prompt-builder.js";
import { createBudgetEnforcer } from "./budget.js";

/**
 * Gateway interface expected by the executor.
 * Matches the shape returned by `createGateway()`.
 */
export interface GatewayLike {
  generateText(
    input: {
      presetId?: string;
      messages: TextMessage[];
      tools?: ToolDefinition[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions
  ): Promise<TextGenerationResult>;

  streamText(
    input: {
      presetId?: string;
      messages: TextMessage[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions
  ): AsyncIterable<StreamEvent>;
}

export interface RuntimeExecutorInput {
  /** Runtime context view from the kernel. */
  context: RuntimeContextView;
  /** System instructions (PLUGIN.md content). */
  instructions?: string;
  /** Override preset ID (default: resolved from providerBinding). */
  presetId?: string;
  /** Runtime API keys from browser. */
  apiKeys?: Record<string, string>;
  /** Trace ID for observability. */
  traceId?: string;
  /** Additional provider request metadata. */
  providerRequestMetadata?: Record<string, unknown>;
}

export interface RuntimeExecutorResult {
  text: string;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
  steps: number;
}

/**
 * Create a runtime executor that composes Provider + Context + Prompt.
 *
 * Reusable by both main story LLM and plugin LLMs.
 */
export function createRuntimeExecutor(gateway: GatewayLike) {
  /**
   * Execute a single non-streaming generation.
   */
  async function execute(
    input: RuntimeExecutorInput
  ): Promise<RuntimeExecutorResult> {
    const budget = createBudgetEnforcer(input.context.runtime.budget);

    try {
      budget.checkStep();

      const messages = buildMessages(input);
      const presetId = resolvePresetId(input);
      const gatewayOptions: GatewayOptions = {
        apiKeys: input.apiKeys,
        traceId: input.traceId,
        signal: budget.signal(),
      };

      const result = await gateway.generateText(
        {
          presetId,
          messages,
          providerRequestMetadata: input.providerRequestMetadata,
        },
        gatewayOptions
      );

      budget.recordTokens(result.usage.inputTokens, result.usage.outputTokens);

      return {
        text: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
        steps: budget.state.steps,
      };
    } finally {
      budget.dispose();
    }
  }

  /**
   * Execute a streaming generation.
   * Yields StreamEvents from the gateway.
   */
  async function* stream(
    input: RuntimeExecutorInput
  ): AsyncIterable<StreamEvent> {
    const budget = createBudgetEnforcer(input.context.runtime.budget);

    try {
      budget.checkStep();

      const messages = buildMessages(input);
      const presetId = resolvePresetId(input);
      const gatewayOptions: GatewayOptions = {
        apiKeys: input.apiKeys,
        traceId: input.traceId,
        signal: budget.signal(),
      };

      for await (const event of gateway.streamText(
        {
          presetId,
          messages,
          providerRequestMetadata: input.providerRequestMetadata,
        },
        gatewayOptions
      )) {
        if (event.type === "done") {
          budget.recordTokens(
            event.usage.inputTokens,
            event.usage.outputTokens
          );
        }
        yield event;
      }
    } finally {
      budget.dispose();
    }
  }

  return { execute, stream };
}

function buildMessages(input: RuntimeExecutorInput): TextMessage[] {
  const opts: PromptBuilderOptions = {
    instructions: input.instructions,
    locale: input.context.locale,
  };
  return buildPrompt(input.context, opts);
}

function resolvePresetId(input: RuntimeExecutorInput): string | undefined {
  // Explicit override takes priority
  if (input.presetId) return input.presetId;
  // Fall back to the runtime's provider binding
  return input.context.runtime.providerBinding;
}
