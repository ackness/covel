import type {
  ModelRequestContext,
  ProviderConfig,
  SpeechSynthesisParams,
  SpeechSynthesisResult,
  TranscriptionParams,
  TranscriptionResult,
} from "../types.js";

/**
 * A pluggable speech-synthesis (TTS) wire — one wire per provider
 * request/response format. Registered under an open string id (NOT an
 * enum): plugins may register additional wires without a framework PR.
 */
export interface SpeechWire {
  readonly id: string;
  synthesize(
    config: ProviderConfig,
    params: SpeechSynthesisParams,
    context?: ModelRequestContext,
  ): Promise<SpeechSynthesisResult>;
}

/**
 * A pluggable transcription (STT) wire — same registration contract as
 * SpeechWire, for the audio→text direction.
 */
export interface TranscriptionWire {
  readonly id: string;
  transcribe(
    config: ProviderConfig,
    params: TranscriptionParams,
    context?: ModelRequestContext,
  ): Promise<TranscriptionResult>;
}
