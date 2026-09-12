import { expect, it, vi } from "vitest";
import { registerImageWire, getImageWire } from "../src/image/wire-registry.js";
import {
  registerSpeechWire,
  getSpeechWire,
  registerTranscriptionWire,
  getTranscriptionWire,
} from "../src/speech/wire-registry.js";

it("old wire disposers cannot delete a re-registration of the same object", () => {
  const image = { id: "dispose-image", generate: vi.fn() };
  const speech = { id: "dispose-speech", synthesize: vi.fn() };
  const transcription = { id: "dispose-transcription", transcribe: vi.fn() };
  const old = [
    registerImageWire(image),
    registerSpeechWire(speech),
    registerTranscriptionWire(transcription),
  ];
  old.forEach((dispose) => dispose());
  const current = [
    registerImageWire(image),
    registerSpeechWire(speech),
    registerTranscriptionWire(transcription),
  ];
  old.forEach((dispose) => dispose());
  expect(getImageWire(image.id)).toBe(image);
  expect(getSpeechWire(speech.id)).toBe(speech);
  expect(getTranscriptionWire(transcription.id)).toBe(transcription);
  current.forEach((dispose) => dispose());
  expect(getImageWire(image.id)).toBeNull();
  expect(getSpeechWire(speech.id)).toBeNull();
  expect(getTranscriptionWire(transcription.id)).toBeNull();
});
