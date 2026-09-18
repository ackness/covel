import { z } from "zod";
import type { LLMProviderContinuation } from "@covel/shared";
import type {
  ProviderConfig,
  ProviderProtocol,
  TextMessage,
} from "../types.js";

const itemsSchema = z.array(z.record(z.string(), z.unknown()));

/** Preserve native output order and opaque state for a tool follow-up. */
export function captureContinuation(
  protocol: ProviderProtocol,
  model: string,
  config: ProviderConfig,
  items: unknown,
): LLMProviderContinuation | undefined {
  const parsed = itemsSchema.safeParse(items);
  if (
    !parsed.success ||
    !parsed.data.some((item) =>
      ["reasoning", "thinking", "redacted_thinking"].includes(
        String(item.type),
      ),
    )
  )
    return undefined;
  return { protocol, model, baseUrl: config.baseUrl, items: parsed.data };
}

export function continuationItems(
  message: TextMessage,
  protocol: ProviderProtocol,
  model: string,
  config: ProviderConfig,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const state = message.providerContinuation;
  if (
    message.role !== "assistant" ||
    !state ||
    state.protocol !== protocol ||
    state.model !== model ||
    state.baseUrl !== config.baseUrl
  )
    return undefined;
  const parsed = itemsSchema.safeParse(state.items);
  return parsed.success && parsed.data.length ? parsed.data : undefined;
}

/** Build native Anthropic blocks without exposing signatures as display text. */
export class AnthropicContinuationAccumulator {
  private readonly blocks = new Map<number, Record<string, unknown>>();
  private invalid = false;
  private readonly toolJson = new Map<number, string>();

  push(payload: Record<string, unknown>): void {
    const index = Number(payload.index ?? 0);
    if (payload.type === "content_block_start") {
      const parsed = itemsSchema.safeParse([payload.content_block]);
      if (parsed.success) this.blocks.set(index, { ...parsed.data[0] });
      return;
    }
    const block = this.blocks.get(index);
    if (!block) return;
    if (payload.type === "content_block_delta") {
      const parsed = itemsSchema.safeParse([payload.delta]);
      const delta = parsed.success ? parsed.data[0] : undefined;
      if (!delta) return;
      for (const [type, key] of [
        ["thinking_delta", "thinking"],
        ["signature_delta", "signature"],
        ["text_delta", "text"],
      ] as const) {
        if (delta.type === type && typeof delta[key] === "string") {
          block[key] = String(block[key] ?? "") + delta[key];
        }
      }
      if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        this.toolJson.set(
          index,
          (this.toolJson.get(index) ?? "") + delta.partial_json,
        );
      }
    }
    if (payload.type === "content_block_stop" && this.toolJson.has(index)) {
      try {
        block.input = JSON.parse(this.toolJson.get(index)!);
      } catch {
        this.invalid = true;
      }
    }
  }

  items(): Record<string, unknown>[] {
    if (this.invalid) return [];
    return [...this.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => block);
  }
}
