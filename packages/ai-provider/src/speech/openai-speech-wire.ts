import type { SpeechWire } from "./types.js";
import type {
  ProviderConfig,
  SpeechSynthesisParams,
  SpeechSynthesisResult,
} from "../types.js";
import { assertSuccess, parseJson, postJson } from "../adapters/http.js";

async function synthesize(
  config: ProviderConfig,
  params: SpeechSynthesisParams,
): Promise<SpeechSynthesisResult> {
  // speechWire is a routing hint consumed by the gateway before it reaches
  // here; parameterOverrides are text-generation params that don't belong
  // in a speech request body. Strip both, forward the rest.
  const {
    speechWire: _wire,
    parameterOverrides: _params,
    ...extra
  } = params.providerRequestMetadata ?? {};

  const response = await postJson(config, "/audio/speech", {
    model: params.model,
    input: params.text,
    ...(params.voice ? { voice: params.voice } : {}),
    ...(params.format ? { format: params.format } : {}),
    ...extra,
  });

  if (!response.ok) {
    const payload = await parseJson(response);
    assertSuccess(response, payload, "openai-speech");
  }

  return {
    audio: {
      mimeType: response.headers.get("content-type") ?? "audio/mpeg",
      data: new Uint8Array(await response.arrayBuffer()),
    },
    usage: null,
    warnings: [],
  };
}

export const openAiSpeechWire: SpeechWire = { id: "openai-speech", synthesize };
