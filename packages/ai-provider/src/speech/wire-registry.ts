import type { SpeechWire, TranscriptionWire } from "./types.js";
import { openAiSpeechWire } from "./openai-speech-wire.js";
import { openAiTranscriptionWire } from "./openai-transcription-wire.js";

export const DEFAULT_SPEECH_WIRE = "openai-speech";
export const DEFAULT_TRANSCRIPTION_WIRE = "openai-transcription";

import { registerWire, getWire } from "../wire-lifecycle.js";
export function registerSpeechWire(wire: SpeechWire): () => void {
  return registerWire("speech", wire);
}
export function getSpeechWire(id: string): SpeechWire | null {
  return getWire("speech", id);
}
export function registerTranscriptionWire(wire: TranscriptionWire): () => void {
  return registerWire("transcription", wire);
}
export function getTranscriptionWire(id: string): TranscriptionWire | null {
  return getWire("transcription", id);
}

registerSpeechWire(openAiSpeechWire);
registerTranscriptionWire(openAiTranscriptionWire);
