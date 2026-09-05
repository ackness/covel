import { describe, expect, it } from "vitest";
import type { RuntimeResult, RuntimeManifest } from "@covel/shared";
import {
  prepareRuntimeRetry,
  settleRuntimeRetry,
} from "../../src/routes/api/actions/runtime-retry.js";
import { batchRetryFixture, seedResult } from "./__helpers/batch-retry.js";

describe("committed runtime recovery projection", () => {
  it("keeps the complete failure summary independent of the selected and active runtime limits", async () => {
    const f = await batchRetryFixture();
    const failedIds = [
      "a",
      "b",
      ...Array.from({ length: 25 }, (_, index) => `inactive-${index}`),
    ].sort();
    await f.store.saveTurnResult({
      id: "wide-source",
      sessionId: f.sessionId,
      turnId: "wide-source",
      origin: "player",
      commitStatus: "committed",
      runtimeResults: failedIds.map((id) => seedResult(id, "failed")),
      durationMs: 1,
      createdAt: "2026-01-02T00:00:00Z",
    });
    const plan = await prepareRuntimeRetry(
      f.store,
      f.sessionId,
      {
        type: "retry_failed_runtimes",
        requestId: "request",
        sessionId: f.sessionId,
        payload: { runtimeIds: ["a"], retryFromTurnId: "wide-source" },
      },
      [{ name: "a" }] as RuntimeManifest[],
    );
    expect(plan.scope?.sourceFailedRuntimeIds).toEqual(failedIds);
    expect(plan.scope?.runtimeIds).toEqual(["a"]);
    expect(
      settleRuntimeRetry(plan, [seedResult("a", "success")], false)
        ?.sourceFailedRuntimeIds,
    ).toEqual(failedIds);
    expect(
      settleRuntimeRetry(plan, [seedResult("a", "skipped")], true)
        ?.sourceFailedRuntimeIds,
    ).toEqual(failedIds);
    expect(
      settleRuntimeRetry(plan, [seedResult("a", "success")], true)
        ?.sourceFailedRuntimeIds,
    ).toEqual(failedIds.filter((id) => id !== "a"));
  });

  it("preserves a skipped dependency as failed while reusing only committed successful siblings", async () => {
    const f = await batchRetryFixture();
    const results: RuntimeResult[] = [
      {
        ...seedResult("a", "success"),
        turnId: "attempt",
        output: { text: "Fresh a" },
      },
      { ...seedResult("b", "skipped"), turnId: "attempt" },
    ];
    await f.store.saveTurnResult({
      id: "attempt",
      sessionId: f.sessionId,
      turnId: "attempt",
      origin: "manual",
      commitStatus: "committed",
      runtimeResults: results,
      durationMs: 1,
      createdAt: "2026-01-02T00:00:00Z",
    });
    await f.store.addTraceEvent({
      id: "attempt-start",
      sessionId: f.sessionId,
      turnId: "attempt",
      traceId: "attempt",
      type: "turn.started",
      payload: { sourceTurnId: "source", runtimeIds: ["a", "b"] },
      createdAt: "2026-01-02T00:00:00Z",
    });
    const plan = await prepareRuntimeRetry(
      f.store,
      f.sessionId,
      {
        type: "retry_failed_runtimes",
        requestId: "request",
        sessionId: f.sessionId,
        payload: { runtimeIds: ["b"], retryFromTurnId: "source" },
      },
      [{ name: "a" }, { name: "b" }] as RuntimeManifest[],
    );
    expect(plan.scope).toEqual({
      sourceTurnId: "source",
      runtimeIds: ["b"],
      sourceCommitted: true,
      sourceFailedRuntimeIds: ["b"],
    });
    expect(plan.seedResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeId: "a",
          output: { text: "Fresh a" },
        }),
        expect.objectContaining({
          runtimeId: "story",
          output: { text: "Original story" },
        }),
      ]),
    );
    expect(plan.seedResults.some((result) => result.runtimeId === "b")).toBe(
      false,
    );
    expect(
      (await f.post({ runtimeIds: ["a"], retryFromTurnId: "source" })).text,
    ).toContain("no longer failed");
    expect(
      (await f.post({ runtimeIds: ["b"], retryFromTurnId: "attempt" })).text,
    ).toContain("original source");
  });
});
