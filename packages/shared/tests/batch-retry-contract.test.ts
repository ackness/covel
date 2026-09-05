import { describe, expect, it } from "vitest";
import { validateActionRequest } from "../src/schemas/api-contract.js";

function validate(payload: unknown) {
  return validateActionRequest({
    requestId: "request",
    sessionId: "session",
    type: "retry_failed_runtimes",
    payload,
  });
}
describe("batch retry action contract", () => {
  it("normalizes a bounded explicit set and preserves interrupted-attempt identity", () => {
    expect(
      validate({
        runtimeIds: ["b", "a"],
        retryFromTurnId: "source",
        recoverFromTurnId: "attempt",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        payload: {
          runtimeIds: ["a", "b"],
          retryFromTurnId: "source",
          recoverFromTurnId: "attempt",
        },
      },
    });
  });
  it.each([
    {},
    { runtimeIds: ["a"] },
    { runtimeIds: [], retryFromTurnId: "source" },
    { runtimeIds: ["a", "a"], retryFromTurnId: "source" },
    {
      runtimeIds: Array.from({ length: 21 }, (_, index) => `runtime-${index}`),
      retryFromTurnId: "source",
    },
    { runtimeIds: ["a"], retryFromTurnId: "source", runtimeId: "a" },
    { runtimeIds: ["../a"], retryFromTurnId: "source" },
  ])("rejects an ambiguous or unbounded payload %j", (payload) => {
    expect(validate(payload).ok).toBe(false);
  });
});
