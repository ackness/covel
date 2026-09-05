import { describe, expect, it, vi } from "vitest";
import { batchRetryFixture, seedResult } from "./__helpers/batch-retry.js";
import { recoveryAction } from "../../src/routes/api/actions/execution-recovery.js";

describe("POST /api/actions batch failure recovery", () => {
  it("commits only failed targets once with original story context and durable source linkage", async () => {
    const f = await batchRetryFixture();
    const transaction = vi.spyOn(f.store, "withTransaction");
    const { events } = await f.post();
    expect(events.map((event) => event.type)).not.toContain("error.occurred");
    expect(f.calls.sort()).toEqual(["a", "b"]);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect((await f.store.getSession(f.sessionId))?.completedPlayerTurns).toBe(
      2,
    );
    for (const id of ["a", "b"]) {
      expect(
        (await f.store.getPluginData(f.sessionId, id, "test", "result"))?.value,
      ).toEqual({ input: { text: "Original story" } });
    }
    const rows = await f.store.listTurnResults(f.sessionId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.commitStatus).toBe("committed");
    expect(rows[1]?.runtimeResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runtimeId: "a", status: "success" }),
        expect.objectContaining({ runtimeId: "b", status: "success" }),
      ]),
    );
    for (const event of events.filter((event) =>
      [
        "execution.started",
        "runtime.started",
        "runtime.completed",
        "execution.completed",
      ].includes(event.type),
    )) {
      expect(event.payload).toMatchObject({
        sourceTurnId: "source",
        runtimeIds: ["a", "b"],
        sourceCommitted: true,
        sourceFailedRuntimeIds:
          event.type === "execution.completed" ? [] : ["a", "b"],
      });
      expect(event.turnId).not.toBe("source");
    }
    expect(
      events.find((event) => event.type === "execution.completed")?.payload
        .committed,
    ).toBe(true);
    const traces = await f.store.listTraceEvents(f.sessionId);
    for (const trace of traces.filter((trace) =>
      [
        "turn.started",
        "runtime.started",
        "runtime.completed",
        "turn.completed",
      ].includes(trace.type),
    )) {
      expect(trace.payload).toMatchObject({
        sourceTurnId: "source",
        runtimeIds: ["a", "b"],
        sourceCommitted: true,
        sourceFailedRuntimeIds:
          trace.type === "turn.completed" ? [] : ["a", "b"],
      });
    }
  });

  it("rejects a queued duplicate after the first attempt has committed", async () => {
    const f = await batchRetryFixture();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    f.beforeRun(async () => {
      started.resolve();
      await finish.promise;
    });
    const first = f.post();
    await started.promise;
    const second = f.post();
    expect(await f.status()).toMatchObject({ state: "running" });
    expect(f.calls.sort()).toEqual(["a", "b"]);
    finish.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(one.events.map((event) => event.type)).not.toContain(
      "error.occurred",
    );
    expect(two.text).toContain("no longer failed");
    expect(f.calls.sort()).toEqual(["a", "b"]);
    expect(await f.status()).toMatchObject({ state: "completed" });
  });

  it("recovers only the remaining failure after a partly successful committed attempt", async () => {
    const f = await batchRetryFixture();
    f.failures.add("b");
    await f.post();
    expect((await f.post()).text).toContain("no longer failed");
    f.failures.clear();
    const retry = await f.post({
      runtimeIds: ["b"],
      retryFromTurnId: "source",
    });
    expect(retry.events.map((event) => event.type)).not.toContain(
      "error.occurred",
    );
    expect(f.calls.sort()).toEqual(["a", "b", "b"]);
  });

  it("continues both targets after the HTTP SSE reader is cancelled without duplicating execution", async () => {
    const f = await batchRetryFixture();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let runningTargets = 0;
    f.beforeRun(async () => {
      if (++runningTargets === 2) started.resolve();
      await finish.promise;
    });
    const response = await f.open();
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(
        "execution.started",
      );
      const drain = (async () => {
        while (!(await reader.read()).done) {
          /* Keep SSE flowing until the client deliberately disconnects. */
        }
      })();
      await started.promise;
      const running = await f.status();
      expect(running).toMatchObject({ state: "running" });
      await reader.cancel();
      await drain;
      expect(await f.status()).toMatchObject({
        state: "running",
        turnId: running.turnId,
      });
      expect(f.calls.sort()).toEqual(["a", "b"]);
      finish.resolve();
      await expect.poll(async () => (await f.status()).state).toBe("completed");
      expect(f.calls.sort()).toEqual(["a", "b"]);
      const rows = await f.store.listTurnResults(f.sessionId);
      expect(rows).toHaveLength(2);
      expect(
        rows.find((row) => row.turnId === running.turnId)?.commitStatus,
      ).toBe("committed");
      for (const runtimeId of ["a", "b"]) {
        expect(
          (
            await f.store.getPluginData(
              f.sessionId,
              runtimeId,
              "test",
              "result",
            )
          )?.value,
        ).toEqual({ input: { text: "Original story" } });
      }
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(2);
    } finally {
      finish.resolve();
      await reader.cancel();
    }
  });

  it("does not count pre-commit success as healed after transaction failure", async () => {
    const f = await batchRetryFixture();
    const transaction = vi
      .spyOn(f.store, "withTransaction")
      .mockRejectedValueOnce(new Error("Synthetic transaction failure"));
    const failed = await f.post();
    expect(
      failed.events.find((event) => event.type === "execution.completed")
        ?.payload,
    ).toMatchObject({
      committed: false,
      sourceCommitted: true,
      sourceFailedRuntimeIds: ["a", "b"],
    });
    expect(
      (await f.store.listTraceEvents(f.sessionId)).find(
        (event) => event.type === "turn.completed",
      )?.payload,
    ).toMatchObject({
      committed: false,
      sourceFailedRuntimeIds: ["a", "b"],
    });
    expect(
      await f.store.getPluginData(f.sessionId, "a", "test", "result"),
    ).toBeNull();
    expect((await f.store.listTurnResults(f.sessionId))[1]?.commitStatus).toBe(
      "failed",
    );
    const retried = await f.post();
    expect(
      retried.events.find((event) => event.type === "execution.completed")
        ?.payload.committed,
    ).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(f.calls.sort()).toEqual(["a", "a", "b", "b"]);
  });

  it.each([
    "missing",
    "uncommitted",
    "inactive",
    "successful",
    "stale",
    "malformed",
  ])("rejects %s source/target before any runtime calls", async (kind) => {
    const f = await batchRetryFixture();
    let source = "source";
    let runtimeIds = ["a", "b"];
    if (kind === "missing") source = "foreign-session-source";
    if (kind === "uncommitted")
      await f.store.setTurnResultCommitStatus(f.sessionId, "source", "pending");
    if (kind === "inactive")
      await f.store.updateSession(f.sessionId, {
        activePlugins: ["story", "a"],
      });
    if (kind === "successful") runtimeIds = ["successful"];
    if (kind === "malformed")
      await f.store
        .saveTurnResult({
          id: "bad",
          sessionId: f.sessionId,
          turnId: "bad",
          origin: "player",
          commitStatus: "committed",
          runtimeResults: null,
          durationMs: 1,
          createdAt: "2026-01-02T00:00:00Z",
        })
        .then(() => {
          source = "bad";
        });
    if (kind === "stale")
      await f.store.saveTurnResult({
        id: "new-story",
        sessionId: f.sessionId,
        turnId: "new-story",
        origin: "continuation",
        commitStatus: "committed",
        runtimeResults: [seedResult("story", "success")],
        durationMs: 1,
        createdAt: "2026-01-02T00:00:00Z",
      });
    const rejected = await f.post({ runtimeIds, retryFromTurnId: source });
    expect(rejected.events.map((event) => event.type)).toContain(
      "error.occurred",
    );
    expect(f.calls).toEqual([]);
  });

  it("protects explicit single retries from stale sources and repeated success", async () => {
    const f = await batchRetryFixture();
    expect(
      (
        await f.post(
          { runtimeId: "a", retryFromTurnId: "missing" },
          "retry_runtime",
        )
      ).text,
    ).toContain("not found");
    await f.post(
      { runtimeId: "a", retryFromTurnId: "source" },
      "retry_runtime",
    );
    expect(
      (
        await f.post(
          { runtimeId: "a", retryFromTurnId: "source" },
          "retry_runtime",
        )
      ).text,
    ).toContain("no longer failed");
    expect(f.calls).toEqual(["a"]);
  });

  it("refreshes an interrupted batch without execution and recovers the exact saved scope", async () => {
    const f = await batchRetryFixture();
    const payload = { runtimeIds: ["a", "b"], retryFromTurnId: "source" };
    await f.store.addTraceEvent({
      id: "interrupted-start",
      sessionId: f.sessionId,
      turnId: "interrupted",
      traceId: "interrupted",
      type: "turn.started",
      payload: {
        sourceTurnId: "source",
        runtimeIds: ["a", "b"],
        recoveryAction: recoveryAction("retry_failed_runtimes", payload),
      },
      createdAt: "2026-01-02T00:00:00Z",
    });
    // These products never committed and must not heal targets or seed context.
    await f.store.saveTurnResult({
      id: "interrupted",
      sessionId: f.sessionId,
      turnId: "interrupted",
      origin: "manual",
      commitStatus: "pending",
      runtimeResults: [seedResult("a", "success"), seedResult("b", "success")],
      durationMs: 1,
      createdAt: "2026-01-02T00:00:00Z",
    });
    expect(await f.status()).toMatchObject({
      state: "interrupted",
      retry: { type: "retry_failed_runtimes", payload },
    });
    expect(f.calls).toEqual([]);
    expect(
      (
        await f.post({
          ...payload,
          runtimeIds: ["a"],
          recoverFromTurnId: "interrupted",
        })
      ).text,
    ).toContain("no longer available");
    expect(f.calls).toEqual([]);
    const recovered = await f.post({
      ...payload,
      recoverFromTurnId: "interrupted",
    });
    expect(
      recovered.events.find((event) => event.type === "execution.completed")
        ?.payload.committed,
    ).toBe(true);
    expect(f.calls.sort()).toEqual(["a", "b"]);
  });
});
