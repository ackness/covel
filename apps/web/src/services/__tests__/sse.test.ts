// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { parseJsonSseData, readSseStream, type SseDiagnostic } from "../sse.js";

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
  it("preserves parser failure and cleans up when diagnostics throw", async () => {
    const error = new Error("parser failed");
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: event\n\n"));
        },
        cancel,
      }),
    );
    await expect(
      readSseStream({
        response,
        parse() {
          throw error;
        },
        onMessage() {},
        onDiagnostic() {
          throw new Error("diagnostic failed");
        },
      }),
    ).rejects.toBe(error);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("cancels a blocked read despite a failing abort observer", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const controller = new AbortController();
    const pending = readSseStream({
      response,
      signal: controller.signal,
      parse: (data) => data,
      onMessage() {},
      onDiagnostic() {
        throw new Error("diagnostic failed");
      },
    });
    controller.abort();
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("keeps healthy EOF successful despite a failing observer", async () => {
    const response = responseFromChunks([]);
    await readSseStream({
      response,
      parse: (data) => data,
      onMessage() {},
      onDiagnostic() {
        throw new Error("diagnostic failed");
      },
    });
    expect(response.body?.locked).toBe(false);
  });

  it.each(["read-error", "parse-error", "message-error"] as const)(
    "reports %s and preserves the original rejection",
    async (kind) => {
      const error = new Error("PRIVATE_MESSAGE");
      error.name = "PRIVATE_NAME";
      const diagnostics: SseDiagnostic[] = [];
      const response = new Response(
        new ReadableStream({
          start(controller) {
            if (kind === "read-error") controller.error(error);
            else
              controller.enqueue(
                new TextEncoder().encode("data: PRIVATE_PAYLOAD\n\n"),
              );
          },
        }),
      );
      await expect(
        readSseStream({
          response,
          parse(data) {
            if (kind === "parse-error") throw error;
            return data;
          },
          onMessage() {
            if (kind === "message-error") throw error;
          },
          onDiagnostic: (value) => diagnostics.push(value),
        }),
      ).rejects.toBe(error);
      expect(diagnostics[0]).toEqual({ type: kind, errorKind: "error" });
      expect(diagnostics).toContainEqual({ type: "cancel" });
      expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_");
      expect(response.body?.locked).toBe(false);
    },
  );

  it("distinguishes clean EOF, abort cancellation and cancellation failure", async () => {
    const eof = vi.fn();
    await readSseStream({
      response: responseFromChunks([]),
      parse: (data) => data,
      onMessage() {},
      onDiagnostic: eof,
    });
    expect(eof).toHaveBeenCalledExactlyOnceWith({ type: "reader-done" });
    const controller = new AbortController();
    const diagnostics = vi.fn();
    const response = new Response(
      new ReadableStream({
        cancel() {
          throw new Error("PRIVATE_CANCEL");
        },
      }),
    );
    const pending = readSseStream({
      response,
      signal: controller.signal,
      parse: (data) => data,
      onMessage() {},
      onDiagnostic: diagnostics,
    });
    controller.abort();
    await pending;
    expect(diagnostics).toHaveBeenCalledWith({ type: "abort" });
    await vi.waitFor(() =>
      expect(diagnostics).toHaveBeenCalledWith({
        type: "cancel-error",
        errorKind: "error",
      }),
    );
    expect(diagnostics).not.toHaveBeenCalledWith({ type: "reader-done" });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("PRIVATE_");
  });

  it("handles split CRLF and CR boundaries and discards an incomplete final frame", async () => {
    const messages: string[] = [];
    const response = responseFromChunks([
      "data:\r",
      "\ndata: second\r\n\r",
      "\ndata: third\r\rdata: uncommitted\n",
    ]);
    await readSseStream({
      response,
      parse: (data) => data,
      onMessage: (data) => messages.push(data),
    });
    expect(messages).toEqual(["\nsecond", "third"]);
    expect(response.body?.locked).toBe(false);
  });

  it("cancels a blocked read and releases the stream on abort", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const controller = new AbortController();
    const onMessage = vi.fn();
    const pending = readSseStream({
      response,
      signal: controller.signal,
      parse: (data) => data,
      onMessage,
    });
    controller.abort();
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("cancels the source when an event consumer throws", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: event\n\n"));
        },
        cancel,
      }),
    );
    await expect(
      readSseStream({
        response,
        parse: (data) => data,
        onMessage() {
          throw new Error("consumer failed");
        },
      }),
    ).rejects.toThrow("consumer failed");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
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
