import { describe, expect, it } from "vitest";
import type { RuntimeResult, RuntimeManifest } from "@covel/shared";
import {
  prepareRuntimeRetry,
  settleRuntimeRetry,
} from "../../src/routes/api/actions/runtime-retry.js";
import { batchRetryFixture, seedResult } from "./__helpers/batch-retry.js";

describe("committed runtime recovery projection", () => {
  it.each([
    {
      type: "retry_runtime",
      payload: { runtimeId: "a", retryFromTurnId: "missing" },
      error: "retry source turn was not found",
    },
    {
      type: "send_message",
      payload: { content: "Continue", recoverFromTurnId: "missing" },
      error: "no longer available for recovery",
    },
  ])(
    "leaves the session unchanged for rejected $type",
    async ({ type, payload, error }) => {
      const f = await batchRetryFixture();
      await f.store.updateSession(f.sessionId, {
        locale: "zh-CN",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const result = await f.post(payload, type);
      expect(result.text).toContain(error);
      expect(await f.store.getSession(f.sessionId)).toMatchObject({
        locale: "zh-CN",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      expect(f.calls).toEqual([]);
    },
  );
  it("uses the parent artifact when recursive results precede the latest source turn", async () => {
    const f = await batchRetryFixture();
    const story = seedResult("story", "success");
    const source = {
      sessionId: f.sessionId,
      turnId: "nested-source",
      commitStatus: "committed" as const,
      durationMs: 1,
    };
    await f.store.saveTurnResult({
      ...source,
      id: "child",
      origin: "recursive",
      parentTurnId: source.turnId,
      runtimeResults: [seedResult("nested", "success")],
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    await f.store.saveTurnResult({
      ...source,
      id: "parent",
      origin: "player",
      runtimeResults: [story, seedResult("a", "failed")],
      createdAt: "2026-02-01T00:00:00.001Z",
    });
    const action = {
      type: "retry_runtime" as const,
      requestId: "request",
      sessionId: f.sessionId,
      payload: { runtimeId: "a", retryFromTurnId: source.turnId },
    };
    const runtimes = [{ name: "a" }] as RuntimeManifest[];
    expect(
      (await prepareRuntimeRetry(f.store, f.sessionId, action, runtimes))
        .seedResults,
    ).toEqual([story]);
    await f.store.saveTurnResult({
      ...source,
      id: "later",
      turnId: "later",
      origin: "player",
      runtimeResults: [story],
      createdAt: "2026-02-01T00:00:01.000Z",
    });
    await expect(
      prepareRuntimeRetry(f.store, f.sessionId, action, runtimes),
    ).rejects.toThrow("story has advanced");
  });
  it("retains guard-provided inputs but excludes ordinary skipped dependencies", async () => {
    const f = await batchRetryFixture();
    const schema = {
      ...seedResult("schema", "skipped"),
      output: { skip: true, worldSchema: { version: 1 } },
    };
    await f.store.saveTurnResult({
      id: "setup-source",
      sessionId: f.sessionId,
      turnId: "setup-source",
      origin: "player",
      commitStatus: "committed",
      durationMs: 1,
      createdAt: "2026-01-02T00:00:00Z",
      runtimeResults: [
        schema,
        seedResult("unavailable", "skipped"),
        seedResult("a", "failed"),
      ],
    });
    const plan = await prepareRuntimeRetry(
      f.store,
      f.sessionId,
      {
        type: "retry_runtime",
        requestId: "request",
        sessionId: f.sessionId,
        payload: { runtimeId: "a", retryFromTurnId: "setup-source" },
      },
      [{ name: "a" }] as RuntimeManifest[],
    );
    expect(plan.seedResults).toEqual([schema]);
  });
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
      retryScope: { sourceTurnId: "source", runtimeIds: ["a", "b"] },
      durationMs: 1,
      createdAt: "2026-01-02T00:00:00Z",
    });
    // Trace retention must not erase the durable retry ledger.
    await f.store.deleteTraceEventsBefore(f.sessionId, "9999-01-01");
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
