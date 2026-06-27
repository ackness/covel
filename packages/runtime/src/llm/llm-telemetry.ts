/**
 * LLM telemetry emit helpers.
 *
 * `turn-agent-tool-loop.ts` (direct-generate fallback path) and `llm-retry.ts`
 * (sync + streaming retry paths) all wrap the same pattern:
 *
 * ```ts
 * if (emitter) await emitter.emit("llm.calling", buildLlmCallingPayload({...}));
 * ```
 *
 * These helpers collapse the null-check + build + emit into one call so the
 * 9 emit sites share a single code path. Payload *shape* is still owned by
 * `llm-trace-payload.ts`; this module only owns the emit wiring.
 */

import {
  buildLlmCallingPayload,
  buildLlmRespondedErrorPayload,
  buildLlmRespondedSuccessPayload,
  type LlmCallingPayloadInput,
  type LlmRespondedErrorInput,
  type LlmRespondedSuccessInput,
} from "./llm-trace-payload.js";
import type { TurnEmitter } from "../trace/turn-emitter.js";

/**
 * Emit an `llm.calling` trace event. No-op when `emitter` is undefined.
 */
export async function emitLlmCalling(
  emitter: TurnEmitter | undefined,
  input: LlmCallingPayloadInput,
): Promise<void> {
  if (!emitter) return;
  await emitter.emit("llm.calling", buildLlmCallingPayload(input));
}

/**
 * Emit an `llm.responded` success trace event. No-op when `emitter` is
 * undefined.
 */
export async function emitLlmRespondedSuccess(
  emitter: TurnEmitter | undefined,
  input: LlmRespondedSuccessInput,
): Promise<void> {
  if (!emitter) return;
  await emitter.emit("llm.responded", buildLlmRespondedSuccessPayload(input));
}

/**
 * Emit an `llm.responded` error trace event. No-op when `emitter` is
 * undefined. Pairs with {@link emitLlmCalling} on every error path so
 * trace-viewer call/response pairing stays intact.
 */
export async function emitLlmRespondedError(
  emitter: TurnEmitter | undefined,
  input: LlmRespondedErrorInput,
): Promise<void> {
  if (!emitter) return;
  await emitter.emit("llm.responded", buildLlmRespondedErrorPayload(input));
}
