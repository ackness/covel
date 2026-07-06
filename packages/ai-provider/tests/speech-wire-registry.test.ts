import { describe, it, expect } from "vitest";
import {
  registerSpeechWire,
  getSpeechWire,
  DEFAULT_SPEECH_WIRE,
  registerTranscriptionWire,
  getTranscriptionWire,
  DEFAULT_TRANSCRIPTION_WIRE,
} from "../src/speech/wire-registry.js";
import type { SpeechWire, TranscriptionWire } from "../src/speech/types.js";

describe("speech wire registry", () => {
  it("has the builtin wire registered", () => {
    expect(getSpeechWire("openai-speech")).not.toBeNull();
    expect(DEFAULT_SPEECH_WIRE).toBe("openai-speech");
  });

  it("returns null for unknown wire", () => {
    expect(getSpeechWire("nope")).toBeNull();
  });

  it("registers a custom wire and rejects duplicate ids", () => {
    const wire: SpeechWire = {
      id: "test-speech-wire",
      synthesize: async () => ({
        audio: { mimeType: "audio/mpeg", data: new Uint8Array() },
        usage: null,
        warnings: [],
      }),
    };
    registerSpeechWire(wire);
    expect(getSpeechWire("test-speech-wire")).toBe(wire);
    expect(() => registerSpeechWire(wire)).toThrow(/already registered/);
  });
});

describe("transcription wire registry", () => {
  it("has the builtin wire registered", () => {
    expect(getTranscriptionWire("openai-transcription")).not.toBeNull();
    expect(DEFAULT_TRANSCRIPTION_WIRE).toBe("openai-transcription");
  });

  it("returns null for unknown wire", () => {
    expect(getTranscriptionWire("nope")).toBeNull();
  });

  it("registers a custom wire and rejects duplicate ids", () => {
    const wire: TranscriptionWire = {
      id: "test-transcription-wire",
      transcribe: async () => ({ text: "", usage: null, warnings: [] }),
    };
    registerTranscriptionWire(wire);
    expect(getTranscriptionWire("test-transcription-wire")).toBe(wire);
    expect(() => registerTranscriptionWire(wire)).toThrow(/already registered/);
  });
});
