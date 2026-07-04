import type { SpeechWire, TranscriptionWire } from "./types.js";
import { openAiSpeechWire } from "./openai-speech-wire.js";
import { openAiTranscriptionWire } from "./openai-transcription-wire.js";

export const DEFAULT_SPEECH_WIRE = "openai-speech";
export const DEFAULT_TRANSCRIPTION_WIRE = "openai-transcription";

// Deliberate runtime Maps (same design as image/wire-registry.ts): plugin
// registration is a designed extension point, not speculative flexibility.
const speechWires = new Map<string, SpeechWire>();
const transcriptionWires = new Map<string, TranscriptionWire>();

export function registerSpeechWire(wire: SpeechWire): void {
  if (speechWires.has(wire.id)) {
    throw new Error(`speech wire "${wire.id}" already registered`);
  }
  speechWires.set(wire.id, wire);
}

export function getSpeechWire(id: string): SpeechWire | null {
  return speechWires.get(id) ?? null;
}

export function registerTranscriptionWire(wire: TranscriptionWire): void {
  if (transcriptionWires.has(wire.id)) {
    throw new Error(`transcription wire "${wire.id}" already registered`);
  }
  transcriptionWires.set(wire.id, wire);
}

export function getTranscriptionWire(id: string): TranscriptionWire | null {
  return transcriptionWires.get(id) ?? null;
}

registerSpeechWire(openAiSpeechWire);
registerTranscriptionWire(openAiTranscriptionWire);
