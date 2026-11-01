import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import { createTurnEmitter } from "@covel/runtime";
import type { SubscriptionEvent } from "@covel/shared";
import { executionProgressPayload } from "../../src/routes/api/execution-progress.js";
import { sessionEventBus } from "../../src/routes/api/session/session-events.js";
import {
  drain,
  isSystemFrame,
  makeApp,
  seedSession,
} from "./sse-test-utils.js";

describe("gameplay progress projection", () => {
  it.each([
    "llm.calling",
    "llm.responded",
    "tool.calling",
    "tool.failed",
    "tool.completed",
    "hook.aborted",
    "recursive.completed",
    "subagent.completed",
    "function.completed",
    "gateway.responded",
  ])(
    "keeps identities, timing and usage without draft or review content on %s",
    (type) => {
      expect(
        executionProgressPayload(type, {
          runtimeId: "story",
          pluginId: "probe",
          turnId: "turn",
          runId: "resumed-run",
          subagentCallId: "child",
          parentCallId: "parent",
          durationMs: 7,
          usage: { inputTokens: 3, outputTokens: 2 },
          success: false,
          text: "draft",
          content: "draft",
          arguments: "draft",
          output: "draft",
          result: "draft",
          parsedResult: { narrativeOutput: "draft" },
          error: "review quotation",
          details: ["review quotation"],
          messages: [{ content: "draft" }],
          toolCalls: [{ arguments: "draft" }],
          providerContinuation: { content: "draft" },
          reasoningContent: "draft",
        }),
      ).toEqual({
        runtimeId: "story",
        pluginId: "probe",
        turnId: "turn",
        runId: "resumed-run",
        subagentCallId: "child",
        parentCallId: "parent",
        durationMs: 7,
        usage: { inputTokens: 3, outputTokens: 2 },
        success: false,
      });
    },
  );

  it("retains safe rejection notes and committed segments", () => {
    const step = {
      turnId: "turn",
      runId: "child",
      step: 3,
      notes: [
        { kind: "output-rejected", reason: "review-rejected", attempt: 2 },
      ],
    };
    expect(
      executionProgressPayload("step.completed", {
        ...step,
        toolChoice: { name: "private" },
        toolCalls: [{ name: "private", success: false }],
        notes: [
          { ...step.notes[0], feedback: "private review" },
          { kind: "private" },
        ],
        output: "private candidate",
      }),
    ).toEqual(step);
    const story = {
      content: "Saved story.",
      messageId: "saved",
      segments: [{ kind: "narration", text: "Saved story." }],
    };
    expect(executionProgressPayload("narrative.completed", story)).toBe(story);
    expect(
      executionProgressPayload("message.completed", story),
    ).toBeUndefined();
  });

  it.each([false, true])(
    "projects live subscription progress while keeping explicit diagnostics (trace: %s)",
    async (diagnostic) => {
      const store = createMemoryStore();
      const eventBus = createEventBus();
      const app = makeApp(store, eventBus);
      await seedSession(store, "progress");
      const session = await store.getSession("progress");
      if (!session) throw new Error("Missing test session");
      const bus = sessionEventBus(eventBus, session);
      const emitter = createTurnEmitter({
        store,
        eventBus: bus,
        sessionId: session.id,
        turnId: "turn",
      });
      const aborter = new AbortController();
      const response = await app.request(
        `/api/events/stream?sessionId=progress${diagnostic ? "&topics=trace" : ""}`,
        { signal: aborter.signal },
      );
      const reader = response.body!.getReader();
      try {
        for (const type of [
          "llm.responded",
          "message.completed",
          "llm.calling",
        ] as const)
          await emitter.emit(type, {
            runtimeId: "story",
            runId: "resumed",
            text: "private draft",
            content: "private draft",
            usage: { inputTokens: 1, outputTokens: 2 },
          });
        const frames = (
          await drain(reader, { deadlineMs: 1000, want: diagnostic ? 3 : 2 })
        ).filter((frame) => !isSystemFrame(frame));
        const payloads = frames.map(
          (frame) =>
            JSON.parse(frame.data!) as {
              type: string;
              payload: Record<string, unknown>;
            },
        );
        expect(payloads.map((event) => event.type)).toEqual(
          diagnostic
            ? ["llm.responded", "message.completed", "llm.calling"]
            : ["llm.responded", "llm.calling"],
        );
        if (diagnostic)
          expect(JSON.stringify(payloads)).toContain("private draft");
        else {
          expect(payloads[0]?.payload).toMatchObject({
            runtimeId: "story",
            runId: "resumed",
            usage: { inputTokens: 1, outputTokens: 2 },
          });
          expect(JSON.stringify(payloads)).not.toContain("private draft");
        }
      } finally {
        aborter.abort();
        await reader.cancel();
        await eventBus.close();
        await store.close();
      }
    },
  );

  it.each([false, true])(
    "delivers safe step/tool/revising progress with gameplay topics (reconnect: %s)",
    async (reconnect) => {
      const store = createMemoryStore();
      const eventBus = createEventBus();
      const app = makeApp(store, eventBus);
      await seedSession(store, "observer");
      const session = await store.getSession("observer");
      if (!session) throw new Error("Missing test session");
      const bus = sessionEventBus(eventBus, session);
      const emitter = createTurnEmitter({
        store,
        eventBus: bus,
        sessionId: session.id,
        turnId: "turn",
      });
      const cursor = eventBus.headCursor(session.id);
      const identity = {
        runtimeId: "story",
        pluginId: "probe",
        runId: "run",
        turnId: "turn",
      };
      const emitActivity = async () => {
        bus.emit({
          id: crypto.randomUUID(),
          type: "event",
          topic: "runtime",
          sessionId: session.id,
          timestamp: new Date().toISOString(),
          payload: { _subType: "runtime.started", ...identity },
        });
        await emitter.emit("step.started", { ...identity, step: 1 });
        await emitter.emit("llm.calling", {
          ...identity,
          messages: ["PRIVATE prompt"],
        });
        await emitter.emit("tool.calling", {
          ...identity,
          toolName: "submit-output",
          arguments: "PRIVATE candidate",
        });
        await emitter.emit("tool.failed", {
          ...identity,
          toolName: "submit-output",
          error: "PRIVATE review",
        });
        await emitter.emit("step.completed", {
          ...identity,
          step: 1,
          notes: [
            {
              kind: "output-rejected",
              reason: "review-rejected",
              attempt: 1,
              feedback: "PRIVATE review",
            },
          ],
          toolCalls: [{ name: "submit-output", success: false }],
        });
        await emitter.emit("step.started", { ...identity, step: 2 });
        await emitter.emit("step.completed", {
          ...identity,
          step: 2,
          notes: [],
          stopReason: "completed",
        });
        bus.emit({
          id: crypto.randomUUID(),
          type: "event",
          topic: "runtime",
          sessionId: session.id,
          timestamp: new Date().toISOString(),
          payload: { _subType: "runtime.completed", ...identity },
        });
        // Other diagnostic events must not slip into a runtime subscription.
        await emitter.emit("llm.responded", {
          ...identity,
          text: "PRIVATE draft",
        });
      };
      if (reconnect) await emitActivity();
      const aborter = new AbortController();
      const response = await app.request(
        `/api/events/stream?sessionId=observer&topics=plugin,system,game,runtime,job,state${reconnect ? `&lastEventId=${encodeURIComponent(cursor)}` : ""}`,
        { signal: aborter.signal },
      );
      const reader = response.body!.getReader();
      try {
        if (!reconnect) await emitActivity();
        const frames = (
          await drain(reader, { deadlineMs: 1000, want: 9 })
        ).filter((frame) => !isSystemFrame(frame));
        const events = frames.map(
          (frame) => JSON.parse(frame.data!) as SubscriptionEvent,
        );
        expect(events.map((event) => event.type)).toEqual([
          "runtime.started",
          "step.started",
          "llm.calling",
          "tool.calling",
          "tool.failed",
          "step.completed",
          "step.started",
          "step.completed",
          "runtime.completed",
        ]);
        expect(events.every((event) => event.topic === "runtime")).toBe(true);
        expect(events[3]?.payload).toMatchObject({
          ...identity,
          toolName: "submit-output",
        });
        expect(events[5]?.payload.notes).toEqual([
          { kind: "output-rejected", reason: "review-rejected", attempt: 1 },
        ]);
        expect(events[7]?.payload).toMatchObject({
          ...identity,
          step: 2,
          notes: [],
        });
        expect(JSON.stringify(events)).not.toContain("PRIVATE");
        // Diagnostics remain intact in storage, independent of the public topic projection.
        expect(
          JSON.stringify(await store.listTraceEvents(session.id)),
        ).toContain("PRIVATE");
        expect(
          JSON.stringify(eventBus.getEventsAfter(session.id, 0).events),
        ).not.toContain("PRIVATE");
      } finally {
        aborter.abort();
        await reader.cancel();
        await eventBus.close();
        await store.close();
      }
    },
  );
});
