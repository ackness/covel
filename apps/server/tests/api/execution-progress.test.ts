import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
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

  it("forwards safe rejection notes and committed segments unchanged", () => {
    const step = {
      turnId: "turn",
      runId: "child",
      step: 3,
      notes: [
        { kind: "output-rejected", reason: "review-rejected", attempt: 2 },
      ],
    };
    expect(executionProgressPayload("step.completed", step)).toBe(step);
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
      const aborter = new AbortController();
      const response = await app.request(
        `/api/events/stream?sessionId=progress${diagnostic ? "&topics=trace" : ""}`,
        { signal: aborter.signal },
      );
      const reader = response.body!.getReader();
      try {
        for (const type of ["llm.responded", "message.completed"])
          bus.emit({
            id: crypto.randomUUID(),
            type: "event",
            topic: "trace",
            sessionId: "progress",
            timestamp: new Date().toISOString(),
            payload: {
              _subType: type,
              runtimeId: "story",
              runId: "resumed",
              text: "private draft",
              content: "private draft",
              usage: { inputTokens: 1, outputTokens: 2 },
            },
          });
        const frames = (
          await drain(reader, { deadlineMs: 1000, want: diagnostic ? 2 : 1 })
        ).filter((frame) => !isSystemFrame(frame));
        const payloads = frames.map(
          (frame) =>
            JSON.parse(frame.data!) as {
              type: string;
              payload: Record<string, unknown>;
            },
        );
        expect(payloads).toHaveLength(diagnostic ? 2 : 1);
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
});
