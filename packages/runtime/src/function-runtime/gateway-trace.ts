/**
 * gateway-trace — wrap a `PluginRuntimeGateway` so each provider call emits
 * `gateway.calling` / `gateway.responded` / `gateway.failed` trace events
 * through the turn-scoped `TurnEmitter` (persisted to trace_events + broadcast).
 *
 * Applied at function-runtime execution time (where the turn emitter lives)
 * rather than injected into the long-lived gateway singleton, so the trace
 * context is correctly scoped to one turn. `resolveSlot` is pure config
 * resolution (no network) and passes through untraced.
 *
 * PII: only the prompt SHAPE (message count + total char length) is emitted —
 * never the raw prompt or response text.
 */

import type { PluginRuntimeGateway } from "@covel/plugin-loader";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import { summarizeTraceError } from "./trace-error.js";

export interface GatewayTraceContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
}

interface GatewayCallInput {
  readonly presetId?: string;
  readonly prompt?: string;
  readonly system?: string;
  readonly messages?: readonly { readonly content: string }[];
}

/** Summarize a call's prompt shape without leaking the text (PII guard). */
function summarizeInput(input: GatewayCallInput): {
  presetId?: string;
  messageCount: number;
  promptChars: number;
} {
  const segments: string[] = [];
  if (input.system) segments.push(input.system);
  if (input.prompt) segments.push(input.prompt);
  if (input.messages) for (const m of input.messages) segments.push(m.content);
  const messageCount = input.messages
    ? input.messages.length
    : (input.system ? 1 : 0) + (input.prompt ? 1 : 0);
  const promptChars = segments.reduce((sum, s) => sum + s.length, 0);
  return {
    ...(input.presetId ? { presetId: input.presetId } : {}),
    messageCount,
    promptChars,
  };
}

/**
 * Return a facade over `gateway` that traces `generateText` / `generateObject`
 * provider calls via `emitter`. Behaviourally identical to the wrapped gateway
 * (same inputs, same returns, same thrown errors).
 */
export function withGatewayTrace(
  gateway: PluginRuntimeGateway,
  emitter: TurnEmitter,
  ctx: GatewayTraceContext,
): PluginRuntimeGateway {
  async function traced<
    R extends {
      finishReason: string;
      usage: { inputTokens: number; outputTokens: number };
    },
  >(
    method: "generateText" | "generateObject",
    summary: ReturnType<typeof summarizeInput>,
    call: () => Promise<R>,
  ): Promise<R> {
    const start = Date.now();
    await emitter.emit("gateway.calling", { ...ctx, method, ...summary });
    try {
      const result = await call();
      await emitter.emit("gateway.responded", {
        ...ctx,
        method,
        finishReason: result.finishReason,
        usage: result.usage,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      await emitter.emit("gateway.failed", {
        ...ctx,
        method,
        error: summarizeTraceError(err),
        durationMs: Date.now() - start,
      });
      throw err;
    }
  }

  const facade: PluginRuntimeGateway = {
    generateText(input) {
      return traced("generateText", summarizeInput(input), () =>
        gateway.generateText(input),
      );
    },
    generateObject<T = unknown>(
      input: Parameters<PluginRuntimeGateway["generateObject"]>[0],
    ) {
      return traced("generateObject", summarizeInput(input), () =>
        gateway.generateObject<T>(input),
      );
    },
    resolveSlot(input) {
      // Pure config resolution, no network — pass through untraced.
      return gateway.resolveSlot(input);
    },
  };

  // Only exposed when the source gateway has an image wire registered —
  // mirrors the same undefined-passthrough guard in plugin-runtime-gateway.ts.
  if (gateway.generateImage) {
    const generateImage = gateway.generateImage.bind(gateway);
    facade.generateImage = async (input) => {
      const start = Date.now();
      const summary = summarizeInput({
        presetId: input.presetId,
        prompt: input.prompt,
      });
      await emitter.emit("gateway.calling", {
        ...ctx,
        method: "generateImage",
        ...summary,
      });
      try {
        const result = await generateImage(input);
        // No usage/finishReason for image calls — cost aggregation
        // (readUsage in the debug cost panel) already treats a missing
        // `usage` field as "skip", so this is a safe, deliberate gap.
        await emitter.emit("gateway.responded", {
          ...ctx,
          method: "generateImage",
          imageCount: result.images.length,
          durationMs: Date.now() - start,
        });
        return result;
      } catch (err) {
        await emitter.emit("gateway.failed", {
          ...ctx,
          method: "generateImage",
          error: summarizeTraceError(err),
          durationMs: Date.now() - start,
        });
        throw err;
      }
    };
  }

  return facade;
}
