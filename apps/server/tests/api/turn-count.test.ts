import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import type { RuntimeManifest } from "@covel/shared";
import { computeSessionTurnCount } from "../../src/routes/api/turn-count.js";

const SID = "sess-tc";

function preGameRuntime(name: string): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0],
    pluginType: "core-plugin",
    priority: 10, // Pre-Game band (<= 99)
    trigger: { type: "auto" },
  } as RuntimeManifest;
}

function mainLoopRuntime(name: string): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0],
    pluginType: "plugin",
    priority: 500, // main-loop band
    trigger: { type: "auto" },
  } as RuntimeManifest;
}

const ACTIVE = [preGameRuntime("pregame"), mainLoopRuntime("narrator")];

async function seed(
  store: DataStore,
  fields: {
    turnCount: number;
    preGameCompleted: string[];
    status?: "active" | "paused" | "ended";
  },
): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    id: SID,
    worldId: "w",
    status: fields.status ?? "active",
    turnCount: fields.turnCount,
    preGameCompleted: fields.preGameCompleted,
    createdAt: now,
    updatedAt: now,
  });
}

async function addTurn(
  store: DataStore,
  turnId: string,
  runtimeResults: unknown[],
  origin?: "player" | "manual" | "follower" | "recursive",
  idSuffix = "",
): Promise<void> {
  await store.saveTurnResult({
    id: `tr-${turnId}${idSuffix}`,
    sessionId: SID,
    turnId,
    runtimeResults,
    ...(origin ? { origin } : {}),
    durationMs: 1,
    createdAt: new Date().toISOString(),
  });
}

describe("computeSessionTurnCount", () => {
  let store: DataStore;
  beforeEach(() => {
    store = createMemoryStore();
  });

  it("keeps the existing turnCount while Pre-Game is pending", async () => {
    await seed(store, { turnCount: 0, preGameCompleted: [] });
    expect(
      await computeSessionTurnCount({
        store,
        sessionId: SID,
        activeRuntimes: ACTIVE,
      }),
    ).toBe(0);
  });

  it("counts only main-loop turn_results once Pre-Game is complete", async () => {
    await seed(store, { turnCount: 1, preGameCompleted: ["pregame"] });
    // Pre-Game-only setup result — excluded.
    await addTurn(store, "t0", [
      { runtimeId: "pregame", output: { preGameDone: true } },
    ]);
    await addTurn(store, "t1", [{ runtimeId: "narrator", output: {} }]);
    await addTurn(store, "t2", [{ runtimeId: "narrator", output: {} }]);
    expect(
      await computeSessionTurnCount({
        store,
        sessionId: SID,
        activeRuntimes: ACTIVE,
      }),
    ).toBe(2);
  });

  it("counts an empty turn_result as a main-loop player turn (no runtime fired)", async () => {
    // Intentional (2026-04-12 audit Finding 3): a main-loop turn where the
    // player advanced but no runtime fired still persists an empty turn_result
    // and counts — the player took a turn. Mirrors the integration assertion in
    // turn-commit-pipeline.test.ts "counts main-loop turns even when no runtime
    // fires". (Pre-Game-only turn_results are still excluded; see below.)
    await seed(store, { turnCount: 1, preGameCompleted: ["pregame"] });
    await addTurn(store, "t1", [{ runtimeId: "narrator", output: {} }]);
    await addTurn(store, "t-empty", []);
    expect(
      await computeSessionTurnCount({
        store,
        sessionId: SID,
        activeRuntimes: ACTIVE,
      }),
    ).toBe(2);
  });

  it("excludes manual / follower / recursive executions from turnCount (M-02)", async () => {
    // Each non-player execution persists its own turn_results row. Counting
    // them inflated session.turnCount, which drives UI turn display and the
    // auto-snapshot cadence — one player input could read as four turns.
    await seed(store, { turnCount: 1, preGameCompleted: ["pregame"] });
    await addTurn(
      store,
      "t1",
      [{ runtimeId: "narrator", output: {} }],
      "player",
    );
    await addTurn(
      store,
      "t-manual",
      [{ runtimeId: "image", output: {} }],
      "manual",
    );
    await addTurn(
      store,
      "t-follower",
      [{ runtimeId: "scene-stage", output: {} }],
      "follower",
    );
    await addTurn(
      store,
      "t-recursive",
      [{ runtimeId: "narrator", output: {} }],
      "recursive",
    );
    expect(
      await computeSessionTurnCount({
        store,
        sessionId: SID,
        activeRuntimes: ACTIVE,
      }),
    ).toBe(1);
  });

  it("counts several executions sharing one turnId as ONE player turn (M-02)", async () => {
    // A Pre-Game completion request can finish setup AND run main-loop
    // followups in the same request — two executions, one logical turn.
    await seed(store, { turnCount: 1, preGameCompleted: ["pregame"] });
    await addTurn(
      store,
      "t1",
      [{ runtimeId: "narrator", output: {} }],
      "player",
    );
    await addTurn(
      store,
      "t1",
      [{ runtimeId: "guide", output: {} }],
      "player",
      "-b",
    );
    expect(
      await computeSessionTurnCount({
        store,
        sessionId: SID,
        activeRuntimes: ACTIVE,
      }),
    ).toBe(1);
  });

  it("treats a legacy row with no origin as a player turn (M-02 back-compat)", async () => {
    await seed(store, { turnCount: 1, preGameCompleted: ["pregame"] });
    await addTurn(store, "t1", [{ runtimeId: "narrator", output: {} }]);
    expect(
      await computeSessionTurnCount({
        store,
        sessionId: SID,
        activeRuntimes: ACTIVE,
      }),
    ).toBe(1);
  });

  it("floors at 1 once Pre-Game runtimes exist even with no main-loop turns", async () => {
    await seed(store, { turnCount: 1, preGameCompleted: ["pregame"] });
    await addTurn(store, "t0", [
      { runtimeId: "pregame", output: { preGameDone: true } },
    ]);
    expect(
      await computeSessionTurnCount({
        store,
        sessionId: SID,
        activeRuntimes: ACTIVE,
      }),
    ).toBe(1);
  });
});
