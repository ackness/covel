import { describe, expect, it, vi } from "vitest";
import { iterateSsePayloads } from "../src/adapters/http.js";

function makeResponse(chunks: readonly Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

async function collect(response: Response): Promise<unknown[]> {
  const payloads: unknown[] = [];
  for await (const payload of iterateSsePayloads(response)) {
    payloads.push(payload);
  }
  return payloads;
}

describe("provider SSE framing", () => {
  it.each(["\n", "\r\n", "\r"])(
    "accepts %j line endings, optional spaces, and multiple data lines across byte chunks",
    async (newline) => {
      const encoded = new TextEncoder().encode(
        [
          ": keepalive",
          "event: delta",
          'data:{"text":',
          'data: "\u4e16\u754c"}',
          "",
          'data: {"done":true}',
          "",
          "",
        ].join(newline),
      );
      const chunks = Array.from(encoded, (byte) => Uint8Array.of(byte));

      await expect(collect(makeResponse(chunks))).resolves.toEqual([
        { text: "\u4e16\u754c" },
        { done: true },
      ]);
    },
  );

  it("discards an incomplete final event", async () => {
    await expect(
      collect(
        new Response('data: {"complete":true}\n\ndata: {"partial":true}\n'),
      ),
    ).resolves.toEqual([{ complete: true }]);
  });

  it("stops at DONE and cancels the remaining response body", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: [DONE]\n\ndata: {"unexpected":true}\n\n',
            ),
          );
        },
        cancel,
      }),
    );

    await expect(collect(response)).resolves.toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("cancels the response when the consumer stops early", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"text":"hello"}\n\n'),
          );
        },
        cancel,
      }),
    );

    for await (const payload of iterateSsePayloads(response)) {
      expect(payload).toEqual({ text: "hello" });
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("reports malformed payloads and releases the reader", async () => {
    const response = new Response("data: invalid\n\n");
    await expect(collect(response)).rejects.toThrow("malformed SSE payload");
    expect(response.body?.locked).toBe(false);
  });
});
