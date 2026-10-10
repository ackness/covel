import type { SpeechWire } from "./types.js";
import type {
  ProviderConfig,
  SpeechSynthesisParams,
  SpeechSynthesisResult,
} from "../types.js";
import {
  assertSuccess,
  MAX_BINARY_RESPONSE_BYTES,
  parseJson,
  postJson,
  readResponseBytes,
} from "../adapters/http.js";

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

  const response = await postJson(
    config,
    "/audio/speech",
    {
      // A role's metadata may fix the voice or the format its model accepts;
      // the model and the text belong to the call and come last.
      ...(params.voice ? { voice: params.voice } : {}),
      ...(params.format ? { response_format: params.format } : {}),
      ...extra,
      model: params.model,
      input: params.text,
    },
    undefined,
    undefined,
    { retry: false },
  );

  if (!response.ok) {
    const payload = await parseJson(response);
    assertSuccess(response, payload, "openai-speech");
  }

  return {
    audio: {
      mimeType: response.headers.get("content-type") ?? "audio/mpeg",
      data: await readResponseBytes(response, MAX_BINARY_RESPONSE_BYTES),
    },
    usage: null,
    warnings: [],
  };
}

export const openAiSpeechWire: SpeechWire = { id: "openai-speech", synthesize };
