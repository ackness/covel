/**
 * The action stream without HTTP: envelope identity, sequence numbers, the
 * current turn's retry scope, story drafts and bus forwarding, observed
 * through a fake SSE sink.
 */

import { describe, expect, it } from "vitest";
import { createEventBus, type EventBus } from "@covel/events";
import type { OutputDraftEvent } from "@covel/runtime";
import type { RuntimeRetryScope } from "@covel/shared";
import {
  createActionStream,
  type ActionStreamSink,
} from "../../src/routes/api/actions/action-stream.js";

const SESSION_ID = "stream-session";
const REQUEST_ID = "stream-request";

interface Envelope {
  readonly type: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly flowId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly seq: number;
  readonly payload: Record<string, unknown>;
}

function fakeSink() {
  const written: Envelope[] = [];
  const abortListeners: Array<() => void | Promise<void>> = [];
  const sink: ActionStreamSink & { aborted: boolean } = {
    aborted: false,
    async writeSSE(message) {
      written.push(JSON.parse(String(message.data)) as Envelope);
    },
    abort() {
      sink.aborted = true;
      for (const listener of abortListeners) void listener();
    },
    onAbort(listener) {
      abortListeners.push(listener);
    },
  };
  return { sink, written };
}

function streamFor(eventBus: EventBus = createEventBus()) {
  const { sink, written } = fakeSink();
  const stream = createActionStream({
    sink,
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    turnId: "turn-1",
    eventBus,
    traceId: "trace-1",
  });
  return { stream, sink, written };
}

function emitForwarded(eventBus: EventBus, sessionId: string, marker: string) {
  eventBus.emit({
    id: crypto.randomUUID(),
    type: "event",
    topic: "plugin",
    sessionId,
    timestamp: new Date().toISOString(),
    payload: { _subType: "plugin-data.changed", marker },
  });
}

describe("action stream", () => {
  it("numbers envelopes in write order and names the current turn", async () => {
    const { stream, written } = streamFor();
    await stream.write("execution.started", { status: "executing" });
    stream.enterTurn("turn-2");
    await stream.write("runtime.started", { runtimeId: "narrator" });
    await stream.write("runtime.deferred", { jobId: "j" }, "turn-1");
    await stream.flush();

    expect(written.map((envelope) => envelope.seq)).toEqual([0, 1, 2]);
    expect(written.map((envelope) => envelope.turnId)).toEqual([
      "turn-1",
      "turn-2",
      "turn-1",
    ]);
    for (const envelope of written) {
      expect(envelope).toMatchObject({
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        traceId: "trace-1",
        flowId: "trace-1",
      });
    }
    expect(stream.turnId).toBe("turn-2");
  });

  it("adds the retry scope to the current turn's events only", async () => {
    const { stream, written } = streamFor();
    const scope: RuntimeRetryScope = {
      sourceTurnId: "source",
      runtimeIds: ["painter"],
    };
    stream.setRetryScope(scope);
    await stream.write("runtime.completed", { runtimeId: "painter" });
    await stream.write("runtime.failed", { runtimeId: "x" }, "other-turn");
    stream.setRetryScope(undefined);
    await stream.write("execution.completed", { committed: true });
    await stream.flush();

    expect(written[0]!.payload).toEqual({ runtimeId: "painter", ...scope });
    expect(written[1]!.payload).toEqual({ runtimeId: "x" });
    expect(written[2]!.payload).toEqual({ committed: true });
  });

  it("snapshots a payload when it is written, not when it is sent", async () => {
    const { stream, written } = streamFor();
    const payload: Record<string, unknown> = { count: 1 };
    await stream.write("operation.failed", payload);
    payload.count = 2;
    await stream.flush();

    expect(written[0]!.payload).toEqual({ count: 1 });
  });

  it("keeps a draft's place and sends its latest content", async () => {
    const { stream, written } = streamFor();
    const draft = (text: string): OutputDraftEvent => ({
      type: "output.draft",
      payload: {
        turnId: "turn-1",
        runtimeId: "narrator",
        pluginId: "narrator",
        draftId: "d1",
        mode: "text",
        units: [],
        partial: { text },
      },
    });
    await stream.write("runtime.started", { runtimeId: "narrator" });
    stream.outputDrafts(draft("Once"));
    await stream.write("tool.calling", { tool: "roll" });
    stream.outputDrafts(draft("Once upon a time"));
    await stream.flush();

    expect(written.map((envelope) => [envelope.seq, envelope.type])).toEqual([
      [0, "runtime.started"],
      [1, "output.draft"],
      [2, "tool.calling"],
    ]);
    expect(written[1]!.payload).toMatchObject({
      partial: { text: "Once upon a time" },
    });
  });

  it("forwards this session's bus events only while forwarding", async () => {
    const eventBus = createEventBus();
    const { stream, written } = streamFor(eventBus);
    emitForwarded(eventBus, SESSION_ID, "before");
    stream.forwardBusEvents();
    emitForwarded(eventBus, SESSION_ID, "during");
    emitForwarded(eventBus, "another-session", "elsewhere");
    stream.stopForwarding();
    emitForwarded(eventBus, SESSION_ID, "after");
    await stream.flush();

    expect(written.map((envelope) => envelope.payload.marker)).toEqual([
      "during",
    ]);
    expect(written[0]).toMatchObject({ type: "plugin-data.changed", seq: 0 });
  });

  it("aborts the transport on a payload it cannot serialize", async () => {
    const { stream, sink, written } = streamFor();
    await expect(
      stream.write("runtime.completed", { size: BigInt(1) }),
    ).resolves.toBeUndefined();
    await stream.write("execution.completed", { committed: true });
    await stream.flush();

    expect(sink.aborted).toBe(true);
    expect(written).toEqual([]);
  });
});
