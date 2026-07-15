import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { EventBus } from "@covel/events";
import {
  DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS,
  saveAutoSnapshot,
} from "../src/snapshot/auto-snapshot.js";

/**
 * Audit 2026-07-11 R-04: auto snapshots are checkpoint-cadenced instead of
 * per-turn. These tests pin the cadence gate: turnCount <= 1 and multiples of
 * the interval snapshot; everything else skips (returns null, writes nothing,
 * emits nothing); `force` bypasses the gate (resume path).
 */

async function makeStore(turnCount: number) {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "sess-throttle",
    worldId: "w1",
    status: "active",
    turnCount,
    preGameCompleted: [],
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
  it("snapshots pre-game (turnCount 0) and the first post-pre-game turn (turnCount 1)", async () => {
    for (const turnCount of [0, 1]) {
      const store = await makeStore(turnCount);
      const saved = await saveAutoSnapshot({
        store,
        sessionId: "sess-throttle",
        turnId: `turn-${turnCount}`,
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
    expect(saved!.payload.session.turnCount).toBe(
      DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS,
    );
  });
});
