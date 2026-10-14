import type { SpeechWire, TranscriptionWire } from "./types.js";
import { openAiSpeechWire } from "./openai-speech-wire.js";
import { openAiTranscriptionWire } from "./openai-transcription-wire.js";

export const DEFAULT_SPEECH_WIRE = "openai-speech";
export const DEFAULT_TRANSCRIPTION_WIRE = "openai-transcription";

import { registerWire, getWire, type WireOwner } from "../wire-lifecycle.js";
/** With `owner`, the wire serves only sessions in which that plugin is active. */
export function registerSpeechWire(
  wire: SpeechWire,
  owner?: WireOwner,
): () => void {
  return registerWire("speech", wire, owner);
}
export function getSpeechWire(id: string): SpeechWire | null {
  return getWire("speech", id);
}
/** With `owner`, the wire serves only sessions in which that plugin is active. */
export function registerTranscriptionWire(
  wire: TranscriptionWire,
  owner?: WireOwner,
): () => void {
  return registerWire("transcription", wire, owner);
}
export function getTranscriptionWire(id: string): TranscriptionWire | null {
  return getWire("transcription", id);
}

registerSpeechWire(openAiSpeechWire);
registerTranscriptionWire(openAiTranscriptionWire);
