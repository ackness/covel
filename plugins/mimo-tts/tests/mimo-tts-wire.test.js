/**
 * L2 — wire test for ../lib/wires.js (the framework-registered SpeechWire).
 *
 * Instantiates the factory with a mock fetchWithRetry/validateBaseUrl and
 * asserts request shape (URL, headers, body) and base64 decode of the
 * response. No framework dependencies so this can run in isolation.
 *
 * Run: pnpm vitest run tests/mimo-tts-wire.test.js
 */

import { describe, it, expect, vi } from "vitest";
import createWires from "../lib/wires.js";

const SAMPLE_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // "ID3" — MP3 magic
const SAMPLE_BASE64 = Buffer.from(SAMPLE_BYTES).toString("base64");

function okResponse(jsonBody) {
  return new Response(JSON.stringify(jsonBody), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeWire(fetchMock) {
  const { speech } = createWires({
    fetchWithRetry: fetchMock,
    validateBaseUrl: () => ({ ok: true }),
  });
  return speech[0];
}

const CONFIG = { baseUrl: "https://api.xiaomimimo.com", apiKey: "sk-test" };

describe("mimo speech wire", () => {
  it('exposes id "mimo" (framework namespaces it to mimo-tts/mimo)', () => {
    const wire = makeWire(vi.fn());
    expect(wire.id).toBe("mimo");
    expect(typeof wire.synthesize).toBe("function");
  });

  it("posts to {baseUrl}/v1/chat/completions with api-key header and assistant message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { audio: { data: SAMPLE_BASE64 } } }],
      }),
    );
    const wire = makeWire(fetchMock);

    const result = await wire.synthesize(CONFIG, {
      model: "mimo-v2.5-tts",
      text: "你好世界",
      voice: "mimo_default",
      format: "mp3",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers["api-key"]).toBe("sk-test");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers.authorization).toBeUndefined();

    const body = JSON.parse(init.body);
    expect(body.model).toBe("mimo-v2.5-tts");
    expect(body.messages).toEqual([{ role: "assistant", content: "你好世界" }]);
    expect(body.audio).toEqual({ format: "mp3", voice: "mimo_default" });

    expect(result.audio.mimeType).toBe("audio/mpeg");
    expect(Array.from(result.audio.data)).toEqual([0x49, 0x44, 0x33, 0x04]);
    expect(result.warnings).toEqual([]);
    expect(result.usage).toBeNull();
  });

  it("tolerates a trailing /v1 in baseUrl (no double prefix)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { audio: { data: SAMPLE_BASE64 } } }],
      }),
    );
    const wire = makeWire(fetchMock);

    await wire.synthesize(
      { baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", apiKey: "sk-x" },
      { model: "mimo-v2.5-tts", text: "hi" },
    );

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
    );
  });

  it("maps wav → audio/wav and defaults voice/format when omitted", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      okResponse({
        choices: [{ message: { audio: { data: SAMPLE_BASE64 } } }],
      }),
    );
    const wire = makeWire(fetchMock);

    const { audio } = await wire.synthesize(CONFIG, {
      model: "mimo-v2-tts",
      text: "hello",
      format: "wav",
    });
    expect(audio.mimeType).toBe("audio/wav");

    await wire.synthesize(CONFIG, { model: "mimo-v2-tts", text: "hello" });
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.audio).toEqual({ format: "mp3", voice: "mimo_default" });
  });

  it("throws a descriptive error when the response payload lacks audio.data", async () => {
    const wire = makeWire(
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: {} }] })),
    );
    await expect(
      wire.synthesize(CONFIG, { model: "mimo-v2.5-tts", text: "x" }),
    ).rejects.toThrow(/audio\.data/);
  });

  it("rejects an unsupported format before fetching", async () => {
    const fetchMock = vi.fn();
    const wire = makeWire(fetchMock);
    await expect(
      wire.synthesize(CONFIG, {
        model: "mimo-v2.5-tts",
        text: "x",
        format: "opus",
      }),
    ).rejects.toThrow(/unsupported format/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a blocked baseUrl before fetching", async () => {
    const fetchMock = vi.fn();
    const { speech } = createWires({
      fetchWithRetry: fetchMock,
      validateBaseUrl: () => ({ ok: false, reason: "private ip" }),
    });
    await expect(
      speech[0].synthesize(
        { baseUrl: "http://10.0.0.1", apiKey: "k" },
        { model: "m", text: "x" },
      ),
    ).rejects.toThrow(/invalid baseUrl/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces HTTP error bodies in the thrown message", async () => {
    const wire = makeWire(
      vi.fn().mockResolvedValue(
        new Response("quota exceeded", {
          status: 429,
          statusText: "Too Many Requests",
        }),
      ),
    );
    await expect(
      wire.synthesize(CONFIG, { model: "mimo-v2.5-tts", text: "x" }),
    ).rejects.toThrow(/HTTP 429/);
  });
});
