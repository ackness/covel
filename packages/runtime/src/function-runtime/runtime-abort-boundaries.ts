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
