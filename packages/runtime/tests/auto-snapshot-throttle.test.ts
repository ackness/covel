import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { EventBus } from "@covel/events";
import {
  DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS,
  saveAutoSnapshot,
} from "../src/snapshot/auto-snapshot.js";

/**
 * Audit 2026-07-11 R-04: auto snapshots are checkpoint-cadenced instead of
 * per-turn. These tests pin the cadence gate on completed player turns.
 */

async function makeStore(completedPlayerTurns: number) {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "sess-throttle",
    worldId: "w1",
    status: "active",
    phase: completedPlayerTurns === 0 ? "setup" : "playing",
    completedPlayerTurns,
    setupRuntimes: {},
    locale: "zh-CN",
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

function makeEventBus(): { bus: EventBus; emitted: unknown[] } {
  const emitted: unknown[] = [];
  const bus = {
    emit: (evt: unknown) => {
      emitted.push(evt);
    },
  } as unknown as EventBus;
  return { bus, emitted };
}

describe("saveAutoSnapshot throttling", () => {
  it("snapshots setup and the first completed player turn", async () => {
    for (const completedPlayerTurns of [0, 1]) {
      const store = await makeStore(completedPlayerTurns);
      const saved = await saveAutoSnapshot({
        store,
        sessionId: "sess-throttle",
        turnId: `turn-${completedPlayerTurns}`,
        intervalTurns: 5,
      });
      expect(saved).not.toBeNull();
      expect(await store.listSnapshots("sess-throttle")).toHaveLength(1);
    }
  });

  it("skips non-checkpoint turns: no record, no event, returns null", async () => {
    const store = await makeStore(3);
    const { bus, emitted } = makeEventBus();

    const saved = await saveAutoSnapshot({
      store,
      sessionId: "sess-throttle",
      turnId: "turn-3",
      intervalTurns: 5,
      eventBus: bus,
    });

    expect(saved).toBeNull();
    expect(await store.listSnapshots("sess-throttle")).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("snapshots on interval multiples and emits state.snapshot.created", async () => {
    const store = await makeStore(10);
    const { bus, emitted } = makeEventBus();

    const saved = await saveAutoSnapshot({
      store,
      sessionId: "sess-throttle",
      turnId: "turn-10",
      intervalTurns: 5,
      eventBus: bus,
    });

    expect(saved).not.toBeNull();
    expect(saved!.kind).toBe("auto");
    expect(saved!.turnId).toBe("turn-10");
    expect(await store.listSnapshots("sess-throttle")).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it("force bypasses the cadence gate (resume path)", async () => {
    const store = await makeStore(3);
    const saved = await saveAutoSnapshot({
      store,
      sessionId: "sess-throttle",
      turnId: "turn-3",
      intervalTurns: 5,
      force: true,
    });
    expect(saved).not.toBeNull();
    expect(await store.listSnapshots("sess-throttle")).toHaveLength(1);
  });

  it("intervalTurns 1 (and values < 1) snapshot every turn", async () => {
    for (const intervalTurns of [1, 0]) {
      const store = await makeStore(7);
      const saved = await saveAutoSnapshot({
        store,
        sessionId: "sess-throttle",
        turnId: "turn-7",
        intervalTurns,
      });
      expect(saved).not.toBeNull();
    }
  });

  it("snapshot payload restores fork state at the checkpoint (messagesCursor points at latest message)", async () => {
    const store = await makeStore(DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS);
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      await store.appendTurnMessage({
        id: `tm-${i}`,
        sessionId: "sess-throttle",
        turnId: `turn-${i}`,
        sourceType: "player",
        role: "user",
        content: `msg ${i}`,
        order: i,
        createdAt: now,
      });
    }

    const saved = await saveAutoSnapshot({
      store,
      sessionId: "sess-throttle",
      turnId: "turn-ckpt",
      intervalTurns: DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS,
    });

    expect(saved).not.toBeNull();
    expect(saved!.payload.messagesCursor).toBe("tm-2");
    expect(saved!.payload.session.completedPlayerTurns).toBe(
      DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS,
    );
  });

  it("captures exactly the summaries referenced by messages through the cursor", async () => {
    const store = await makeStore(DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS);
    const now = new Date().toISOString();
    await store.saveSessionSummary({
      id: "summary-required",
      sessionId: "sess-throttle",
      turnRangeStart: "turn-1",
      turnRangeEnd: "turn-1",
      content: "Required history.",
      focusSections: ["history"],
      createdAt: now,
    });
    await store.saveSessionSummary({
      id: "summary-orphan",
      sessionId: "sess-throttle",
      turnRangeStart: "turn-old",
      turnRangeEnd: "turn-old",
      content: "Not referenced by the captured message prefix.",
      focusSections: [],
      createdAt: now,
    });
    await store.appendTurnMessage({
      id: "tm-compacted",
      sessionId: "sess-throttle",
      turnId: "turn-1",
      sourceType: "runtime",
      role: "assistant",
      content: "Preserved raw history.",
      order: 0,
      createdAt: now,
      compactedAtTurnId: "summary-required",
    });

    const saved = await saveAutoSnapshot({
      store,
      sessionId: "sess-throttle",
      turnId: "turn-ckpt",
      intervalTurns: DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS,
    });

    expect(saved?.payload.sessionSummaries).toEqual([
      expect.objectContaining({ id: "summary-required" }),
    ]);
  });

  it("refuses to capture a compaction tag whose summary is missing", async () => {
    const store = await makeStore(DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS);
    await store.appendTurnMessage({
      id: "tm-orphan-tag",
      sessionId: "sess-throttle",
      turnId: "turn-1",
      sourceType: "runtime",
      role: "assistant",
      content: "This raw content must not be hidden by a snapshot.",
      order: 0,
      createdAt: new Date().toISOString(),
      compactedAtTurnId: "missing-summary",
    });

    await expect(
      saveAutoSnapshot({
        store,
        sessionId: "sess-throttle",
        turnId: "turn-ckpt",
        intervalTurns: DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS,
      }),
    ).rejects.toThrow(
      "Turn messages reference missing session summary while building snapshot: missing-summary",
    );
    expect(await store.listSnapshots("sess-throttle")).toEqual([]);
  });
});
