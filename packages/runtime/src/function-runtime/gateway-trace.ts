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
 * never the raw prompt or response body. Provider-exposed reasoning is retained
 * separately for the user-visible thinking panel and DEBUG.
 */

import type {
  PluginRuntimeGateway,
  PluginEvaluationInput,
  EvaluationQuestions,
} from "@covel/shared/plugin-runtime";
import type { LLMDiagnostics, LLMUsageSummary } from "@covel/shared";
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

/** Keep function-runtime traces free of citation text, URLs and refusal prose. */
function summarizeDiagnostics(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const diagnostics = value as Record<string, unknown>;
  const warningTypes = Array.isArray(diagnostics.warnings)
    ? diagnostics.warnings.flatMap((warning: unknown) => {
        const type =
          warning && typeof warning === "object" && "type" in warning
            ? warning.type
            : undefined;
        return type === "unsupported" ||
          type === "compatibility" ||
          type === "other"
          ? [type]
          : [];
      })
    : [];
  const refusal = diagnostics.refusal;
  const reason =
    refusal && typeof refusal === "object" && "reason" in refusal
      ? refusal.reason
      : undefined;
  return {
    warningTypes,
    sourceCount: Array.isArray(diagnostics.sources)
      ? diagnostics.sources.length
      : 0,
    citationCount: Array.isArray(diagnostics.citations)
      ? diagnostics.citations.length
      : 0,
    ...(reason === "refusal" || reason === "content-filter"
      ? { refusalReason: reason }
      : {}),
  };
}

function errorDiagnostics(error: unknown): unknown {
  const details =
    error && typeof error === "object" && "details" in error
      ? error.details
      : undefined;
  return details && typeof details === "object" && "diagnostics" in details
    ? details.diagnostics
    : undefined;
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
      finishReason?: string;
      reasoningContent?: string;
      diagnostics?: LLMDiagnostics;
      usage: LLMUsageSummary;
      model?: string;
      provider?: string;
    },
  >(
    method: "generateText" | "generateObject" | "evaluate",
    summary: Record<string, unknown>,
    call: () => Promise<R>,
  ): Promise<R> {
    const start = Date.now();
    await emitter.emit("gateway.calling", { ...ctx, method, ...summary });
    try {
      const result = await call();
      const diagnosticsSummary = summarizeDiagnostics(result.diagnostics);
      await emitter.emit("gateway.responded", {
        ...(diagnosticsSummary ? { diagnosticsSummary } : {}),
        ...ctx,
        method,
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        ...(result.reasoningContent
          ? { reasoningContent: result.reasoningContent }
          : {}),
        usage: result.usage,
        ...(result.model ? { model: result.model } : {}),
        ...(result.provider ? { provider: result.provider } : {}),
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      const diagnosticsSummary = summarizeDiagnostics(errorDiagnostics(err));
      await emitter.emit("gateway.failed", {
        ...(diagnosticsSummary ? { diagnosticsSummary } : {}),
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

  if (gateway.evaluate) {
    const evaluate = gateway.evaluate.bind(gateway);
    facade.evaluate = <const Q extends EvaluationQuestions>(
      input: PluginEvaluationInput<Q>,
    ) =>
      traced(
        "evaluate",
        {
          ...(input.presetId ? { presetId: input.presetId } : {}),
          questionCount: Object.keys(input.questions).length,
          stateChars: JSON.stringify(input.state).length,
        },
        () => evaluate<Q>(input),
      );
  }

  if (gateway.synthesizeSpeech) {
    const synthesizeSpeech = gateway.synthesizeSpeech.bind(gateway);
    facade.synthesizeSpeech = async (input) => {
      const start = Date.now();
      const summary = summarizeInput({
        presetId: input.presetId,
        prompt: input.text,
      });
      await emitter.emit("gateway.calling", {
        ...ctx,
        method: "synthesizeSpeech",
        ...summary,
      });
      try {
        const result = await synthesizeSpeech(input);
        await emitter.emit("gateway.responded", {
          ...ctx,
          method: "synthesizeSpeech",
          audioBytes: result.audio.data.byteLength,
          durationMs: Date.now() - start,
        });
        return result;
      } catch (err) {
        await emitter.emit("gateway.failed", {
          ...ctx,
          method: "synthesizeSpeech",
          error: summarizeTraceError(err),
          durationMs: Date.now() - start,
        });
        throw err;
      }
    };
  }

  if (gateway.composeMusic) {
    const composeMusic = gateway.composeMusic.bind(gateway);
    facade.composeMusic = async (input) => {
      const start = Date.now();
      const summary = summarizeInput({
        presetId: input.presetId,
        prompt: input.prompt,
      });
      await emitter.emit("gateway.calling", {
        ...ctx,
        method: "composeMusic",
        ...summary,
      });
      try {
        const result = await composeMusic(input);
        await emitter.emit("gateway.responded", {
          ...ctx,
          method: "composeMusic",
          audioBytes: result.audio.data.byteLength,
          durationMs: Date.now() - start,
        });
        return result;
      } catch (err) {
        await emitter.emit("gateway.failed", {
          ...ctx,
          method: "composeMusic",
          error: summarizeTraceError(err),
          durationMs: Date.now() - start,
        });
        throw err;
      }
    };
  }

  if (gateway.transcribeAudio) {
    const transcribeAudio = gateway.transcribeAudio.bind(gateway);
    facade.transcribeAudio = async (input) => {
      const start = Date.now();
      await emitter.emit("gateway.calling", {
        ...ctx,
        method: "transcribeAudio",
        ...(input.presetId ? { presetId: input.presetId } : {}),
        audioBytes: input.audio.data.byteLength,
      });
      try {
        const result = await transcribeAudio(input);
        await emitter.emit("gateway.responded", {
          ...ctx,
          method: "transcribeAudio",
          textChars: result.text.length,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.model ? { model: result.model } : {}),
          ...(result.provider ? { provider: result.provider } : {}),
          durationMs: Date.now() - start,
        });
        return result;
      } catch (err) {
        await emitter.emit("gateway.failed", {
          ...ctx,
          method: "transcribeAudio",
          error: summarizeTraceError(err),
          durationMs: Date.now() - start,
        });
        throw err;
      }
    };
  }

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
