import type {
  PluginRuntimeGateway,
  PluginRuntimeUtils,
  PluginEvaluationInput,
  EvaluationQuestions,
} from "@covel/shared/plugin-runtime";
import { combineAbortSignals } from "../turn-executor/turn-control.js";

function signalFor(
  defaultSignal: AbortSignal,
  explicitSignal: AbortSignal | undefined,
): AbortSignal {
  return combineAbortSignals(defaultSignal, explicitSignal) ?? defaultSignal;
}

/** Apply the runtime deadline even when a plugin omits an explicit signal. */
export function withDefaultGatewaySignal(
  gateway: PluginRuntimeGateway,
  defaultSignal: AbortSignal,
): PluginRuntimeGateway {
  const facade: PluginRuntimeGateway = {
    generateText(input) {
      return gateway.generateText({
        ...input,
        signal: signalFor(defaultSignal, input.signal),
      });
    },
    generateObject<T = unknown>(
      input: Parameters<PluginRuntimeGateway["generateObject"]>[0],
    ) {
      return gateway.generateObject<T>({
        ...input,
        signal: signalFor(defaultSignal, input.signal),
      });
    },
    resolveSlot(input) {
      return gateway.resolveSlot(input);
    },
  };

  if (gateway.evaluate) {
    const evaluate = gateway.evaluate.bind(gateway);
    facade.evaluate = <const Q extends EvaluationQuestions>(
      input: PluginEvaluationInput<Q>,
    ) =>
      evaluate<Q>({ ...input, signal: signalFor(defaultSignal, input.signal) });
  }
  if (gateway.generateImage) {
    const generateImage = gateway.generateImage.bind(gateway);
    facade.generateImage = (input) =>
      generateImage({
        ...input,
        signal: signalFor(defaultSignal, input.signal),
      });
  }
  if (gateway.synthesizeSpeech) {
    const synthesizeSpeech = gateway.synthesizeSpeech.bind(gateway);
    facade.synthesizeSpeech = (input) =>
      synthesizeSpeech({
        ...input,
        signal: signalFor(defaultSignal, input.signal),
      });
  }
  if (gateway.composeMusic) {
    const composeMusic = gateway.composeMusic.bind(gateway);
    facade.composeMusic = (input) =>
      composeMusic({
        ...input,
        signal: signalFor(defaultSignal, input.signal),
      });
  }
  if (gateway.transcribeAudio) {
    const transcribeAudio = gateway.transcribeAudio.bind(gateway);
    facade.transcribeAudio = (input) =>
      transcribeAudio({
        ...input,
        signal: signalFor(defaultSignal, input.signal),
      });
  }

  return facade;
}

/**
 * The least time a text call gets before it is given up as stalled. A call
 * that is not streamed shows no progress, so a slow answer and a stalled one
 * look the same until the time is over.
 */
const STALLED_CALL_MIN_WAIT_MS = 60_000;

/** The abort reason of a text call that was given up to be sent again. */
class StalledCallError extends Error {
  override readonly name = "TimeoutError";

  constructor(waitedMs: number) {
    super(`no reply from the model in ${Math.round(waitedMs / 1000)}s`);
  }
}

/**
 * Send a text call again when the model does not answer, inside the time the
 * runtime has. The gateway repeats a request the provider rejected, but one
 * the provider accepted and never answered would otherwise hold the handler
 * until the runtime's own limit ends it.
 *
 * The first attempt may use half of the time left, and at least
 * {@link STALLED_CALL_MIN_WAIT_MS}; the second one gets the rest. A runtime
 * with less time than that makes one attempt, as before.
 */
export function withStalledCallRetry(
  gateway: PluginRuntimeGateway,
  options: {
    /** When the runtime's time ends (ms since epoch). */
    readonly deadline: number;
    readonly runtimeId: string;
  },
): PluginRuntimeGateway {
  async function sendTwice<I extends { readonly signal?: AbortSignal }, R>(
    input: I,
    send: (input: I) => Promise<R>,
  ): Promise<R> {
    const remainingMs = options.deadline - Date.now();
    const waitMs = Math.max(
      remainingMs / 2,
      Math.min(STALLED_CALL_MIN_WAIT_MS, remainingMs),
    );
    if (waitMs >= remainingMs) return send(input);
    const stalled = new AbortController();
    const timer = setTimeout(
      () => stalled.abort(new StalledCallError(waitMs)),
      waitMs,
    );
    try {
      return await send({
        ...input,
        signal: signalFor(stalled.signal, input.signal),
      });
    } catch (error) {
      // Only the stall guard is answered with a second attempt: a failure the
      // gateway reported and an abort by the caller stay what they are.
      if (!stalled.signal.aborted || input.signal?.aborted) throw error;
      console.warn(
        `[covel:warn] [runtime-retry] ${options.runtimeId} attempt=1 reason=call-timeout cause=${(stalled.signal.reason as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    return send(input);
  }

  const facade: PluginRuntimeGateway = {
    ...gateway,
    generateText: (input) =>
      sendTwice(input, (attempt) => gateway.generateText(attempt)),
    generateObject: <T = unknown>(
      input: Parameters<PluginRuntimeGateway["generateObject"]>[0],
    ) => sendTwice(input, (attempt) => gateway.generateObject<T>(attempt)),
  };
  if (gateway.evaluate) {
    const evaluate = gateway.evaluate.bind(gateway);
    facade.evaluate = <const Q extends EvaluationQuestions>(
      input: PluginEvaluationInput<Q>,
    ) => sendTwice(input, (attempt) => evaluate<Q>(attempt));
  }
  return facade;
}

/** Apply the runtime deadline to plugin-owned HTTP requests by default. */
export function withDefaultUtilsSignal(
  utils: PluginRuntimeUtils,
  defaultSignal: AbortSignal,
): PluginRuntimeUtils {
  return {
    validateBaseUrl: (url) => utils.validateBaseUrl(url),
    fetchWithRetry(input, init) {
      return utils.fetchWithRetry(input, {
        ...init,
        signal: signalFor(defaultSignal, init?.signal),
      });
    },
  };
}
