import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TraceEvent } from "@/services/api.js";
import { llmAttempts } from "../-llm-attempts.js";
import { LLMRequestInspector } from "../-llm-request-inspector.js";
import { deriveRuntimesFromTurn, getTraceError } from "../-debug-helpers.js";
import i18n from "@/i18n";

afterEach(cleanup);
const event = (
  type: string,
  seq: number,
  payload: Record<string, unknown> = {},
): TraceEvent => ({
  type,
  seq,
  requestId: "request",
  sessionId: "session",
  turnId: "turn",
  traceId: "trace",
  flowId: "flow",
  timestamp: "2026-09-01T00:00:00Z",
  payload: { runtimeId: "story", ...payload },
});

describe("provider request inspection", () => {
  it("renders and copies referenced retry bodies", () => {
    const body = {
      model: "retry-model",
      messages: [{ role: "user", content: "Retried prompt" }],
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      render(
        <LLMRequestInspector
          event={event("llm.calling", 1, {
            providerRequests: [
              { schemaVersion: 1, body, statusCode: 429, complete: true },
              { schemaVersion: 2, bodyRef: 0, statusCode: 200, complete: true },
            ],
          })}
          logical={<p>Logical prompt</p>}
        />,
      );
      expect(screen.getAllByText(/Retried prompt/)).toHaveLength(2);
      fireEvent.click(
        screen.getAllByRole("button", {
          name: i18n.t("debugger.copyProviderBody"),
        })[1],
      );
      expect(writeText).toHaveBeenCalledWith(JSON.stringify(body, null, 2));
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("pairs retries without mixing a later tool-loop call or another runtime", () => {
    const events = [
      event("llm.calling", 1, { attempt: 0 }),
      event("llm.responded", 2, { attempt: 0, finishReason: "error" }),
      event("llm.calling", 3, { attempt: 1 }),
      event("llm.responded", 4, { attempt: 1, finishReason: "stop" }),
      event("llm.calling", 5, { attempt: 0 }),
      event("llm.responded", 6, { attempt: 0, finishReason: "error" }),
      event("llm.calling", 7, { runtimeId: "other" }),
    ];
    expect(
      llmAttempts(events[0], events).map(({ call, attempt, status }) => ({
        call,
        attempt,
        status,
      })),
    ).toEqual([
      { call: 1, attempt: 0, status: "recovered" },
      { call: 1, attempt: 1, status: "succeeded" },
      { call: 2, attempt: 0, status: "failed" },
    ]);
  });
  it("classifies runtime.completed carrying a failed outcome as a failure", () => {
    const failed = event("runtime.completed", 9, {
      status: "failed",
      error: "Budget exhausted",
    });
    expect(getTraceError(failed)?.message).toBe("Budget exhausted");
    expect(deriveRuntimesFromTurn([failed])[0].status).toBe("failed");
  });
  it("shows the actual serialized body separately from logical messages", () => {
    render(
      <LLMRequestInspector
        event={event("llm.calling", 1, {
          providerRequests: [
            {
              body: {
                model: "actual-model",
                messages: [
                  { role: "user", content: "Synthetic provider body" },
                ],
              },
              provider: "fixture",
              protocol: "chat",
              statusCode: 200,
              complete: true,
            },
          ],
        })}
        logical={<p>Logical prompt</p>}
      />,
    );
    expect(screen.getByText(/Synthetic provider body/)).toBeTruthy();
    expect(screen.queryByText("Logical prompt")).toBeNull();
    fireEvent.click(screen.getAllByRole("tab")[1]);
    expect(screen.getByText("Logical prompt")).toBeTruthy();
    expect(screen.queryByText(/Synthetic provider body/)).toBeNull();
  });
});
