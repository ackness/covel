/**
 * Session Snapshot Builder TDD.
 *
 * Builds a complete SessionSnapshot for client restore/reconnection.
 */

import { describe, it, expect, vi } from "vitest";
import { buildSessionSnapshot } from "../src/snapshot/snapshot-builder.js";

describe("buildSessionSnapshot", () => {
  function createMockStore() {
    return {
      getSession: vi.fn().mockResolvedValue({
        id: "sess-1",
        worldId: "neonridge",
        status: "active",
        turnCount: 3,
        preGameCompleted: [],
        locale: "zh-CN",
      }),
      listMessages: vi.fn().mockResolvedValue([
        {
          id: "m1",
          role: "user",
          content: "Hello",
          metadata: { turnId: "t1" },
          createdAt: "2026-01-01",
        },
        {
          id: "m2",
          role: "assistant",
          content: "Story text.",
          metadata: { turnId: "t1", runtimeId: "narrator", kind: "story" },
          createdAt: "2026-01-01",
        },
      ]),
      listCharacters: vi.fn().mockResolvedValue([
        {
          id: "c1",
          name: "Hero",
          type: "player",
          description: "The protagonist",
          fields: { class: "warrior" },
        },
      ]),
      listStateSchemas: vi
        .fn()
        .mockResolvedValue([{ tableName: "world" }, { tableName: "player" }]),
      listStateEntries: vi
        .fn()
        .mockImplementation((_sid: string, table: string) => {
          if (table === "world")
            return Promise.resolve([
              { tableName: "world", fieldName: "weather", value: "rain" },
              { tableName: "world", fieldName: "time", value: "night" },
            ]);
          if (table === "player")
            return Promise.resolve([
              { tableName: "player", fieldName: "hp", value: 100 },
            ]);
          return Promise.resolve([]);
        }),
      listTraceEvents: vi.fn().mockResolvedValue([
        {
          type: "runtime.started",
          turnId: "t1",
          payload: { runtimeId: "narrator" },
          createdAt: "2026-01-01",
        },
        {
          type: "runtime.completed",
          turnId: "t1",
          payload: { runtimeId: "narrator", durationMs: 500 },
          createdAt: "2026-01-01",
        },
      ]),
    };
  }

  it("should build a complete snapshot from store data", async () => {
    const store = createMockStore();
    const snapshot = await buildSessionSnapshot(store as any, "sess-1");

    // Session metadata
    expect(snapshot.session.id).toBe("sess-1");
    expect(snapshot.session.worldId).toBe("neonridge");
    expect(snapshot.session.turnCount).toBe(3);

    // Messages flattened from metadata
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0].role).toBe("user");
    expect(snapshot.messages[0].turnId).toBe("t1");
    expect(snapshot.messages[1].kind).toBe("story");
    expect(snapshot.messages[1].runtimeId).toBe("narrator");

    // Characters
    expect(snapshot.characters).toHaveLength(1);
    expect(snapshot.characters[0].name).toBe("Hero");

    // Game state aggregated from state entries
    expect(snapshot.gameState).toEqual({
      world: { weather: "rain", time: "night" },
      player: { hp: 100 },
    });

    // Execution steps
    expect(snapshot.executionSteps).toHaveLength(2);
    expect(snapshot.executionSteps[0].type).toBe("runtime.started");
  });

  it("should return null if session not found", async () => {
    const store = createMockStore();
    store.getSession.mockResolvedValue(null);

    const snapshot = await buildSessionSnapshot(store as any, "nonexistent");
    expect(snapshot).toBeNull();
  });

  it("should handle empty collections gracefully", async () => {
    const store = createMockStore();
    store.listMessages.mockResolvedValue([]);
    store.listCharacters.mockResolvedValue([]);
    store.listStateSchemas.mockResolvedValue([]);
    store.listStateEntries.mockResolvedValue([]);
    store.listTraceEvents.mockResolvedValue([]);

    const snapshot = await buildSessionSnapshot(store as any, "sess-1");

    expect(snapshot).not.toBeNull();
    expect(snapshot!.messages).toEqual([]);
    expect(snapshot!.characters).toEqual([]);
    expect(snapshot!.gameState).toEqual({});
    expect(snapshot!.executionSteps).toEqual([]);
  });
});
