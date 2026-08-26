import { FormData as UndiciFormData } from "undici";
import type { TranscriptionWire } from "./types.js";
import type {
  ProviderConfig,
  TranscriptionParams,
  TranscriptionResult,
} from "../types.js";
import {
  appendProviderMetadata,
  assertSuccess,
  parseJson,
  postFormData,
} from "../adapters/http.js";

async function transcribe(
  config: ProviderConfig,
  params: TranscriptionParams,
): Promise<TranscriptionResult> {
  // Production requests use the package-pinned npm Undici transport. Use its
  // matching FormData implementation so multipart bodies retain their brand
  // across Node/Electron Undici version boundaries.
  const formData = new UndiciFormData();
  formData.set("model", params.model);
  formData.set(
    "file",
    new Blob([params.audio.data.buffer as ArrayBuffer], {
      type: params.audio.mimeType,
    }),
    params.audio.fileName ?? "audio.bin",
  );
  // transcriptionWire is a routing hint consumed by the gateway;
  // parameterOverrides are text-generation params. Neither belongs on the wire.
  const {
    transcriptionWire: _wire,
    parameterOverrides: _params,
    ...extra
  } = params.providerRequestMetadata ?? {};
  appendProviderMetadata(formData, extra);

  const response = await postFormData(
    config,
    "/audio/transcriptions",
    formData,
  );
  const payload = await parseJson(response);
  assertSuccess(response, payload, "openai-transcription");

  const transcriptionUsage =
    payload.usage && typeof payload.usage === "object"
      ? (payload.usage as Record<string, unknown>)
      : null;
  return {
    text: String(payload.text ?? ""),
    usage: transcriptionUsage
      ? {
          inputTokens: Number(transcriptionUsage.prompt_tokens ?? 0),
          outputTokens: Number(transcriptionUsage.completion_tokens ?? 0),
        }
      : null,
    warnings: [],
  };
}

export const openAiTranscriptionWire: TranscriptionWire = {
  id: "openai-transcription",
  transcribe,
};
