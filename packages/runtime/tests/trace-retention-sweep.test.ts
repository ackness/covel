import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { setTraceRetentionPlayerSource } from "@covel/shared";
import {
  __resetTraceSweepForTests,
  maybeSweepOldTraces,
} from "../src/commit/trace-retention.js";

const DAY = 86_400_000;

async function seed() {
  const store = createMemoryStore();
  for (const id of ["a", "b"]) {
    await store.createSession({
      id,
      locale: "en-US",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      activePlugins: [],
      completedPlayerTurns: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    for (const [suffix, age] of [
      ["old", 40],
      ["new", 1],
    ] as const) {
      await store.addTraceEvent({
        id: `${id}-${suffix}`,
        sessionId: id,
        turnId: "turn",
        traceId: "trace",
        type: "llm.calling",
        payload: {},
        createdAt: new Date(Date.now() - age * DAY).toISOString(),
      });
    }
  }
  return store;
}

async function ids(store: Awaited<ReturnType<typeof seed>>, session: string) {
  return (await store.listTraceEvents(session)).map((event) => event.id);
}

describe("maybeSweepOldTraces", () => {
  beforeEach(() => {
    __resetTraceSweepForTests();
    vi.stubEnv("COVEL_TRACE_RETENTION_DAYS", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setTraceRetentionPlayerSource(undefined);
  });

  it("prunes every session, not only one that just committed", async () => {
    const store = await seed();
    expect(await maybeSweepOldTraces(store, { force: true })).toBe(2);
    expect(await ids(store, "a")).toEqual(["a-new"]);
    expect(await ids(store, "b")).toEqual(["b-new"]);
  });

  it("runs at most once a day unless forced", async () => {
    const store = await seed();
    const now = Date.now();
    expect(await maybeSweepOldTraces(store, { now })).toBe(2);
    expect(await maybeSweepOldTraces(store, { now: now + 3_600_000 })).toBe(0);
    expect(await maybeSweepOldTraces(store, { now: now + DAY + 1 })).toBe(2);
    expect(await maybeSweepOldTraces(store, { now, force: true })).toBe(2);
  });

  it("deletes nothing when the player keeps everything", async () => {
    setTraceRetentionPlayerSource(() => 0);
    const store = await seed();
    expect(await maybeSweepOldTraces(store, { force: true })).toBe(0);
    expect(await ids(store, "a")).toHaveLength(2);
  });

  it("follows the player's period, and the operator's variable over it", async () => {
    setTraceRetentionPlayerSource(() => 90);
    const store = await seed();
    await maybeSweepOldTraces(store, { force: true });
    expect(await ids(store, "a")).toHaveLength(2);

    vi.stubEnv("COVEL_TRACE_RETENTION_DAYS", "7");
    await maybeSweepOldTraces(store, { force: true });
    expect(await ids(store, "a")).toEqual(["a-new"]);
  });

  it("logs a failing session and still sweeps the others", async () => {
    const store = await seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const real = store.deleteTraceEventsBefore.bind(store);
    const flaky = {
      listSessions: () => store.listSessions(),
      deleteTraceEventsBefore: async (id: string, before: string) => {
        if (id === "a") throw new Error("disk");
        await real(id, before);
      },
    };
    try {
      expect(await maybeSweepOldTraces(flaky, { force: true })).toBe(1);
      expect(await ids(store, "b")).toEqual(["b-new"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
