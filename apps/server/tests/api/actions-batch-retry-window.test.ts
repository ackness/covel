import { describe, expect, it } from "vitest";
import { buildSessionSnapshot, createTurnEmitter } from "@covel/runtime";
import type { RuntimeRetryScope } from "@covel/shared";
import { batchRetryFixture } from "./__helpers/batch-retry.js";

describe("batch recovery through the bounded trace window", () => {
  it("publishes the committed remainder after an early successful task leaves the snapshot window", async () => {
    const f = await batchRetryFixture();
    f.failures.add("b");
    f.beforeRun(async (runtimeId) => {
      if (runtimeId !== "b") return;
      await expect
        .poll(async () =>
          (await f.store.listTraceEvents(f.sessionId)).some(
            (event) =>
              event.type === "runtime.completed" &&
              (event.payload as Record<string, unknown>).runtimeId === "a",
          ),
        )
        .toBe(true);
      const started = (await f.store.listTraceEvents(f.sessionId)).find(
        (event) => event.type === "turn.started",
      )!;
      const payload = started.payload as RuntimeRetryScope;
      const emitter = createTurnEmitter({
        store: f.store,
        sessionId: f.sessionId,
        turnId: started.turnId,
        traceId: started.traceId,
        retryScope: {
          sourceTurnId: payload.sourceTurnId,
          runtimeIds: payload.runtimeIds,
          sourceCommitted: payload.sourceCommitted,
          sourceFailedRuntimeIds: payload.sourceFailedRuntimeIds,
        },
      });
      // Exercise the real emitter's scope propagation while enough later trace
      // rows evict A's lifecycle and the source turn from the restore window.
      for (let index = 0; index < 610; index++) {
        await emitter.emit("llm.responded", {
          runtimeId: "b",
          pluginId: "b",
          step: index,
        });
      }
    });
    const { events } = await f.post();
    const completed = events.find(
      (event) => event.type === "execution.completed",
    )!;
    expect(completed.payload).toMatchObject({
      committed: true,
      sourceCommitted: true,
      runtimeIds: ["a", "b"],
      sourceFailedRuntimeIds: ["b"],
    });
    const snapshot = await buildSessionSnapshot(f.store, f.sessionId);
    expect(snapshot?.executionSteps).toHaveLength(600);
    expect(
      snapshot?.executionSteps.some(
        (event) =>
          event.type === "runtime.completed" && event.payload.runtimeId === "a",
      ),
    ).toBe(false);
    expect(
      snapshot?.executionSteps.find((event) => event.type === "llm.responded")
        ?.payload,
    ).toMatchObject({
      sourceCommitted: true,
      sourceFailedRuntimeIds: ["a", "b"],
    });
    expect(
      snapshot?.executionSteps.find((event) => event.type === "turn.completed")
        ?.payload,
    ).toMatchObject({
      committed: true,
      sourceCommitted: true,
      sourceTurnId: "source",
      sourceFailedRuntimeIds: ["b"],
    });
    expect(f.calls.sort()).toEqual(["a", "b"]);
  });
});
