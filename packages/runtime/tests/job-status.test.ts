/**
 * Kernel job-status channel: identity injection, idempotency, JSON-boundary
 * validation, execution finalize mapping, and the full handler → ctx.progress
 * → store + SSE chain.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus, type EventBus } from "@covel/events";
import type { FunctionHandlerContext } from "@covel/plugin-loader";
import {
  createProgressReporter,
  finalizeJobStatuses,
  type ProgressReporterDeps,
} from "../src/job-status/job-status.js";

const SESSION = "sess-1";
const SCOPE = "exec-1";
const PLUGIN = "media-gen";
const RUNTIME = "media-gen/worker";

interface Harness {
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly deps: ProgressReporterDeps;
  readonly jobEvents: unknown[];
}

function makeHarness(overrides?: Partial<ProgressReporterDeps>): Harness {
  const store = createMemoryStore();
  const eventBus = createEventBus();
  const jobEvents: unknown[] = [];
  eventBus.onEmit((e) => {
    if (e.type === "job-status.updated") jobEvents.push(e);
  });
  const deps: ProgressReporterDeps = {
    store,
    eventBus,
    sessionId: SESSION,
    progressScopeId: SCOPE,
    pluginId: PLUGIN,
    runtimeId: RUNTIME,
    ...overrides,
  };
  return { store, eventBus, deps, jobEvents };
}

describe("createProgressReporter.report", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("writes the event to the store with kernel-injected identity", async () => {
    const reporter = createProgressReporter(h.deps);
    await reporter.report({
      jobId: "job-a",
      state: "running",
      progress: 0.4,
      message: "rendering",
      data: { frame: 3, nested: { ok: true } },
      sequence: 1,
    });

    const rows = await h.store.listJobStatus(SESSION);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Identity is injected by the kernel, not by the handler-supplied effect.
    expect(row.sessionId).toBe(SESSION);
    expect(row.progressScopeId).toBe(SCOPE);
    expect(row.pluginId).toBe(PLUGIN);
    expect(row.runtimeId).toBe(RUNTIME);
    // Business fields come from the effect.
    expect(row.jobId).toBe("job-a");
    expect(row.state).toBe("running");
    expect(row.progress).toBe(0.4);
    expect(row.message).toBe("rendering");
    expect(row.data).toEqual({ frame: 3, nested: { ok: true } });
    expect(typeof row.createdAt).toBe("string");
  });

  it("emits a job-status.updated SSE event carrying the full record", async () => {
    const reporter = createProgressReporter(h.deps);
    await reporter.report({ jobId: "job-a", state: "queued", sequence: 1 });

    expect(h.jobEvents).toHaveLength(1);
    const ev = h.jobEvents[0] as {
      type: string;
      sessionId: string;
      payload: Record<string, unknown>;
    };
    expect(ev.type).toBe("job-status.updated");
    expect(ev.sessionId).toBe(SESSION);
    expect(ev.payload).toMatchObject({
      jobId: "job-a",
      state: "queued",
      pluginId: PLUGIN,
      runtimeId: RUNTIME,
      progressScopeId: SCOPE,
      sequence: 1,
    });
  });

  it("silently drops a duplicate/older sequence without overwriting", async () => {
    const reporter = createProgressReporter(h.deps);
    await reporter.report({ jobId: "job-a", state: "running", sequence: 1 });
    // Same (jobId, sequence) with a different state — must be rejected.
    await reporter.report({ jobId: "job-a", state: "failed", sequence: 1 });

    const rows = await h.store.listJobStatus(SESSION, { jobId: "job-a" });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("running"); // earlier event wins
    // Only the first (accepted) write emitted an SSE event.
    expect(h.jobEvents).toHaveLength(1);
  });

  it("rejects a data payload with a deeply-nested undefined", async () => {
    const reporter = createProgressReporter(h.deps);
    await expect(
      reporter.report({
        jobId: "job-a",
        state: "running",
        sequence: 1,
        data: { a: { b: undefined as unknown as null } },
      }),
    ).rejects.toThrow(/not JSON-serialisable/);
    // Nothing persisted or emitted when validation throws before the write.
    expect(await h.store.listJobStatus(SESSION)).toHaveLength(0);
    expect(h.jobEvents).toHaveLength(0);
  });

  it("rejects a circular data payload", async () => {
    const reporter = createProgressReporter(h.deps);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      reporter.report({
        jobId: "job-a",
        state: "running",
        sequence: 1,
        data: circular as never,
      }),
    ).rejects.toThrow(/circular/);
  });

  it("rejects a non-finite number in data", async () => {
    const reporter = createProgressReporter(h.deps);
    await expect(
      reporter.report({
        jobId: "job-a",
        state: "running",
        sequence: 1,
        data: { pct: Number.NaN },
      }),
    ).rejects.toThrow(/non-finite/);
  });
});

describe("finalizeJobStatuses", () => {
  it.each([
    ["success", "succeeded"],
    ["failed", "failed"],
    ["skipped", "cancelled"],
    ["suspended", "waiting-input"],
  ] as const)(
    "maps outcome %s onto job state %s and increments sequence",
    async (outcome, expectedState) => {
      const h = makeHarness();
      const reporter = createProgressReporter(h.deps);
      await reporter.report({ jobId: "job-a", state: "running", sequence: 5 });

      await finalizeJobStatuses(h.deps, {
        outcome,
        reportedJobs: ["job-a"],
      });

      const rows = await h.store.listJobStatus(SESSION, { jobId: "job-a" });
      expect(rows).toHaveLength(2);
      expect(rows[1].state).toBe(expectedState);
      expect(rows[1].sequence).toBe(6); // max committed sequence + 1
    },
  );

  it("does not re-map a job already in a terminal state", async () => {
    const h = makeHarness();
    const reporter = createProgressReporter(h.deps);
    await reporter.report({ jobId: "job-a", state: "succeeded", sequence: 1 });

    await finalizeJobStatuses(h.deps, {
      outcome: "failed",
      reportedJobs: ["job-a"],
    });

    const rows = await h.store.listJobStatus(SESSION, { jobId: "job-a" });
    expect(rows).toHaveLength(1); // untouched
    expect(rows[0].state).toBe("succeeded");
  });

  it("finalizes only the reported jobs", async () => {
    const h = makeHarness();
    const reporter = createProgressReporter(h.deps);
    await reporter.report({ jobId: "job-a", state: "running", sequence: 1 });
    await reporter.report({ jobId: "job-b", state: "running", sequence: 1 });

    await finalizeJobStatuses(h.deps, {
      outcome: "success",
      reportedJobs: ["job-a"],
    });

    const a = await h.store.listJobStatus(SESSION, { jobId: "job-a" });
    const b = await h.store.listJobStatus(SESSION, { jobId: "job-b" });
    expect(a.at(-1)?.state).toBe("succeeded");
    expect(b).toHaveLength(1); // never reported to finalize → left running
    expect(b[0].state).toBe("running");
  });
});

describe("ctx.progress full chain", () => {
  it("lets a function handler report progress through the injected ctx", async () => {
    const h = makeHarness();
    const reporter = createProgressReporter(h.deps);

    // A minimal function handler that only touches ctx.progress — the same
    // shape executeFunctionRuntime injects. Domain writes would use the return
    // value; progress is the live side channel.
    const handler = async (ctx: FunctionHandlerContext) => {
      await ctx.progress?.report({
        jobId: "img-1",
        state: "queued",
        sequence: 1,
      });
      await ctx.progress?.report({
        jobId: "img-1",
        state: "progress",
        progress: 0.5,
        sequence: 2,
      });
      return { narrativeOutput: "done" };
    };

    const ctx = {
      sessionId: SESSION,
      turnId: "turn-1",
      pluginId: PLUGIN,
      runtimeId: RUNTIME,
      playerMessage: "",
      store: {},
      completedResults: new Map(),
      recursiveCall: async () => {
        throw new Error("not configured");
      },
      recursionDepth: 0,
      progress: reporter,
    } satisfies FunctionHandlerContext;

    const out = await handler(ctx);
    expect(out).toEqual({ narrativeOutput: "done" });

    const rows = await h.store.listJobStatus(SESSION, { jobId: "img-1" });
    expect(rows.map((r) => r.state)).toEqual(["queued", "progress"]);
    expect(h.jobEvents).toHaveLength(2);
  });
});
