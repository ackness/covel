import { describe, expect, it } from "vitest";
import type { SessionExecutionStatus } from "@covel/shared";
import { createRecoveryActionRequest } from "../execution-recovery-actions.js";

describe("explicit recovery retries", () => {
  it.each([
    { type: "send_message", payload: { content: "Answer the captain" } },
    { type: "execute_command", payload: { command: "/roll 1d6" } },
    { type: "retry_turn", payload: {} },
    { type: "start_session", payload: {} },
    { type: "retry_runtime", payload: { runtimeId: "guide" } },
  ] satisfies NonNullable<SessionExecutionStatus["retry"]>[])(
    "preserves $type input and guards the original turn",
    (retry) => {
      const status: SessionExecutionStatus = {
        state: "interrupted",
        turnId: "original",
        requestId: "old-request",
        retry,
      };
      expect(createRecoveryActionRequest(status, "session-1", "en-US")).toEqual(
        {
          requestId: expect.any(String),
          sessionId: "session-1",
          locale: "en-US",
          type: retry.type,
          payload: { ...retry.payload, recoverFromTurnId: "original" },
        },
      );
      expect(
        createRecoveryActionRequest(status, "session-1", "en-US")?.requestId,
      ).not.toBe("old-request");
    },
  );
  it.each(["idle", "running", "completed"] as const)(
    "does not retry %s tasks",
    (state) => {
      expect(
        createRecoveryActionRequest(
          {
            state,
            turnId: "original",
            retry: { type: "retry_turn", payload: {} },
          },
          "s",
          "en-US",
        ),
      ).toBeUndefined();
    },
  );
  it("does not invent an input for an interrupted turn without a retry descriptor", () => {
    expect(
      createRecoveryActionRequest(
        { state: "interrupted", turnId: "original" },
        "s",
        "en-US",
      ),
    ).toBeUndefined();
  });
});
