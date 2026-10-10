import { afterEach, describe, expect, it, vi } from "vitest";
import {
  iterateSsePayloads,
  ProviderResponseTooLargeError,
  readResponseBytes,
  readResponseText,
} from "../src/adapters/http/response.js";
import { normalizeError } from "../src/gateway-lifecycle.js";
import { openAiSpeechWire } from "../src/speech/openai-speech-wire.js";
import type { ProviderConfig } from "../src/types.js";

/** A body that never ends: every read hands out one more chunk. */
function endlessResponse(
  chunk: Uint8Array,
  headers?: Record<string, string>,
): { response: Response; pulls: () => number; cancelled: () => boolean } {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers },
  );
  return { response, pulls: () => pulls, cancelled: () => cancelled };
}

const KIB = new Uint8Array(1024).fill(0x61);

afterEach(() => vi.unstubAllGlobals());

describe("provider response body ceiling", () => {
  it("stops reading a text body once it passes the ceiling", async () => {
    const body = endlessResponse(KIB);

    await expect(readResponseText(body.response, 4096)).rejects.toThrow(
      ProviderResponseTooLargeError,
    );
    expect(body.cancelled()).toBe(true);
    // Four chunks fit; the fifth passes the ceiling and nothing follows it.
    expect(body.pulls()).toBeLessThanOrEqual(6);
  });

  it("stops reading a binary body once it passes the ceiling", async () => {
    const body = endlessResponse(KIB);

    await expect(readResponseBytes(body.response, 4096)).rejects.toThrow(
      ProviderResponseTooLargeError,
    );
    expect(body.cancelled()).toBe(true);
  });

  it("rejects on Content-Length before the first read", async () => {
    const body = endlessResponse(KIB, { "content-length": "4097" });

    await expect(readResponseText(body.response, 4096)).rejects.toThrow(
      ProviderResponseTooLargeError,
    );
    expect(body.pulls()).toBe(0);
    expect(body.cancelled()).toBe(true);
  });

  it("returns a body that ends exactly at the ceiling", async () => {
    const text = "世界".repeat(100);
    const bytes = new TextEncoder().encode(text);

    await expect(
      readResponseText(new Response(bytes), bytes.byteLength),
    ).resolves.toBe(text);
    await expect(
      readResponseBytes(new Response(bytes), bytes.byteLength),
    ).resolves.toEqual(bytes);
  });

  it("is a provider error that is not retried", () => {
    const error = normalizeError(
      new ProviderResponseTooLargeError(4096),
      "test",
    );

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.retriable).toBe(false);
  });

  it("applies the media ceiling to synthesized audio", async () => {
    const body = endlessResponse(KIB, {
      "content-type": "audio/mpeg",
      "content-length": String(50 * 1024 * 1024 + 1),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => body.response),
    );
    const config: ProviderConfig = {
      provider: "test",
      baseUrl: "https://x.test",
      apiKey: "k",
      protocol: "openai-chat-v1",
    };

    await expect(
      openAiSpeechWire.synthesize(config, { model: "tts-1", text: "hello" }),
    ).rejects.toThrow(ProviderResponseTooLargeError);
    expect(body.pulls()).toBe(0);
  });
});

describe("provider SSE event ceiling", () => {
  async function collect(
    response: Response,
    maxEventChars: number,
  ): Promise<unknown[]> {
    const payloads: unknown[] = [];
    for await (const payload of iterateSsePayloads(response, maxEventChars)) {
      payloads.push(payload);
    }
    return payloads;
  }

  it("stops a stream that never ends its line", async () => {
    const body = endlessResponse(KIB);

    await expect(collect(body.response, 4096)).rejects.toThrow(
      ProviderResponseTooLargeError,
    );
    expect(body.cancelled()).toBe(true);
  });

  it("stops an event that never reaches its blank line", async () => {
    const body = endlessResponse(
      new TextEncoder().encode(`data: ${"a".repeat(512)}\n`),
    );

    await expect(collect(body.response, 4096)).rejects.toThrow(
      ProviderResponseTooLargeError,
    );
  });

  it("does not limit the stream as a whole", async () => {
    const event = `: keepalive\ndata: {"text":"${"a".repeat(1000)}"}\n\n`;
    const response = new Response(event.repeat(50));

    await expect(collect(response, 2048)).resolves.toHaveLength(50);
  });
});
