import { describe, expect, it } from "vitest";
import { parseJsonSseData, readSseStream } from "../sse.js";

function responseFromChunks(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  );
}

describe("readSseStream", () => {
  it("reads data-only JSON events split across chunks", async () => {
    const events: unknown[] = [];

    await readSseStream({
      response: responseFromChunks([
        'data: {"type":"progress"}\n\n',
        'data: {"type":"done","id":"w1"}\n',
        "\n",
      ]),
      parse: parseJsonSseData,
      onMessage: (event) => events.push(event),
    });

    expect(events).toEqual([{ type: "progress" }, { type: "done", id: "w1" }]);
  });

  it("preserves full SSE id and event fields", async () => {
    const events: unknown[] = [];

    await readSseStream({
      response: responseFromChunks([
        "id: evt-1\n",
        "event: runtime.started\n",
        'data: {"payload":{"runtimeId":"r1"}}\n\n',
      ]),
      parse: (data, message) => ({
        id: message.id,
        event: message.event,
        data: parseJsonSseData(data),
      }),
      onMessage: (event) => events.push(event),
    });

    expect(events).toEqual([
      {
        id: "evt-1",
        event: "runtime.started",
        data: { payload: { runtimeId: "r1" } },
      },
    ]);
  });

  it("joins multi-line data fields before parsing", async () => {
    const messages: string[] = [];

    await readSseStream({
      response: responseFromChunks(["data: line 1\n", "data: line 2\n\n"]),
      parse: (data) => data,
      onMessage: (event) => messages.push(event),
    });

    expect(messages).toEqual(["line 1\nline 2"]);
  });
});
