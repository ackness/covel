import { describe, expect, it, vi } from "vitest";
import { abandonExecution } from "../src/index.js";
import { presenter, setup, timestamp } from "./presentation-fixture.js";

/** A player turn whose detached presenter becomes a queued job on commit. */
async function preparedTurn() {
  const f = await setup();
  const execution = await f.run(
    async () => ({ outcome: "success", value: {} }),
    presenter({ turnCompletion: { mode: "detached" } }),
  );
  const [job] = execution.result.deferredRuntimeJobs ?? [];
  expect(job?.presentation).toBeDefined();
  // Another execution's row, which abandoning this one must not touch.
  await f.store.saveTurnResult({
    id: "other-row",
    sessionId: "session",
    turnId: "other-turn",
    runtimeResults: [],
    origin: "manual",
    commitStatus: "pending",
    durationMs: 0,
    createdAt: timestamp,
  });
  return { ...f, execution, job: job! };
}

async function statuses(
  store: Awaited<ReturnType<typeof setup>>["store"],
): Promise<Record<string, string[]>> {
  const byTurn: Record<string, string[]> = {};
  for (const row of await store.listTurnResults("session"))
    (byTurn[row.turnId] ??= []).push(row.commitStatus);
  return byTurn;
}

async function presentationCompletions(
  store: Awaited<ReturnType<typeof setup>>["store"],
) {
  return (
    await store.queryTraceEvents("session", {
      types: ["presentation.completed"],
    })
  ).map((event) => event.payload);
}

describe("abandonExecution", () => {
  it("settles the execution's results failed and its presentations unavailable", async () => {
    const f = await preparedTurn();
    expect(await statuses(f.store)).toEqual({
      source: ["pending"],
      "other-turn": ["pending"],
    });

    await abandonExecution({ execution: f.execution, store: f.store });

    expect(await statuses(f.store)).toEqual({
      source: ["failed"],
      "other-turn": ["pending"],
    });
    expect(await presentationCompletions(f.store)).toEqual([
      expect.objectContaining({
        jobId: f.job.jobId,
        status: "no-op",
        reason: "unavailable",
      }),
    ]);
    // Settled once: a second exit of the same host path changes nothing.
    const settle = vi.spyOn(f.store, "setTurnResultCommitStatus");
    await abandonExecution({ execution: f.execution, store: f.store });
    expect(settle).not.toHaveBeenCalled();
    await f.store.close();
  });

  it("logs store failures instead of throwing", async () => {
    const f = await preparedTurn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const broken = {
        ...f.store,
        setTurnResultCommitStatus: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
        queryTraceEvents: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      };

      await expect(
        abandonExecution({ execution: f.execution, store: broken }),
      ).resolves.toBeUndefined();

      expect(broken.setTurnResultCommitStatus).toHaveBeenCalledWith(
        "session",
        "source",
        "failed",
        [],
        [],
      );
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
    await f.store.close();
  });

  it("leaves an execution that reached commitExecution to its commit", async () => {
    const f = await preparedTurn();
    expect((await f.commit(f.execution)).status).toBe("committed");
    expect((await statuses(f.store)).source).toEqual(["committed"]);
    // A store that would let a late failure overwrite the committed row.
    const permissive = {
      ...f.store,
      setTurnResultCommitStatus: vi.fn(f.store.setTurnResultCommitStatus),
      queryTraceEvents: vi.fn(f.store.queryTraceEvents),
    };

    await abandonExecution({ execution: f.execution, store: permissive });

    expect(permissive.setTurnResultCommitStatus).not.toHaveBeenCalled();
    expect(permissive.queryTraceEvents).not.toHaveBeenCalled();
    expect((await statuses(f.store)).source).toEqual(["committed"]);
    expect(await presentationCompletions(f.store)).not.toContainEqual(
      expect.objectContaining({ reason: "unavailable" }),
    );
    await f.store.close();
  });
});
