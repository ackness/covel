/**
 * Contract tests for MemoryStore (ServerStore interface).
 *
 * Validates every method of the ServerStore interface against
 * the in-memory implementation. These tests document the expected
 * behavior that any alternative backend (e.g. PgServerStore) must match.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { createMemoryStore } from "../src/store/memory-store.js";
import type { ServerStore } from "../src/store/types.js";

const WORLDS_DIR = resolve(import.meta.dirname, "../../../worlds");
let store: ServerStore;

beforeEach(async () => {
  store = await createMemoryStore(WORLDS_DIR);
});

// ─── Worlds ──────────────────────────────────────────────────────────────────

describe("MemoryStore — Worlds", () => {
  /** Verify that seed worlds are loaded on creation. */
  it("should seed worlds on creation", async () => {
    const worlds = await store.listWorlds();
    expect(worlds.length).toBeGreaterThan(0);
  });

  /** createWorld returns a world with a generated ID and timestamps. */
  it("should create a world with generated ID", async () => {
    const world = await store.createWorld("Test World", "A test world");
    expect(world.id).toBeTruthy();
    expect(world.id).toMatch(/^world_/);
    expect(world.name).toBe("Test World");
    expect(world.description).toBe("A test world");
    expect(world.createdAt).toBeTruthy();
  });

  /** createWorld preserves optional fields. */
  it("should create a world with optional fields", async () => {
    const world = await store.createWorld("Lore World", "desc", {
      lore: "Ancient history",
      locale: "en-US",
      tags: ["fantasy", "medieval"],
    });
    expect(world.lore).toBe("Ancient history");
    expect(world.locale).toBe("en-US");
    expect(world.tags).toEqual(["fantasy", "medieval"]);
  });

  /** listWorlds returns all worlds sorted by createdAt descending. */
  it("should list worlds sorted by createdAt desc", async () => {
    const worlds = await store.listWorlds();
    for (let i = 1; i < worlds.length; i++) {
      expect(worlds[i - 1].createdAt >= worlds[i].createdAt).toBe(true);
    }
  });

  /** getWorld returns the world by ID. */
  it("should get a world by ID", async () => {
    const created = await store.createWorld("Get Test", "desc");
    const fetched = await store.getWorld(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe("Get Test");
  });

  /** getWorld returns undefined for a non-existent ID. */
  it("should return undefined for non-existent world", async () => {
    const result = await store.getWorld("nonexistent-id");
    expect(result).toBeUndefined();
  });

  /** updateWorld patches fields and sets updatedAt. */
  it("should update a world and set updatedAt", async () => {
    const world = await store.createWorld("Original", "original desc");
    expect(world.updatedAt).toBeUndefined();

    const updated = await store.updateWorld(world.id, {
      name: "Updated",
      description: "updated desc",
    });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe("Updated");
    expect(updated!.description).toBe("updated desc");
    expect(updated!.updatedAt).toBeTruthy();
    expect(updated!.createdAt).toBe(world.createdAt);
  });

  /** updateWorld returns undefined for non-existent ID. */
  it("should return undefined when updating non-existent world", async () => {
    const result = await store.updateWorld("nonexistent", { name: "Nope" });
    expect(result).toBeUndefined();
  });

  /** updateWorld only patches provided fields. */
  it("should partially update world fields", async () => {
    const world = await store.createWorld("Partial", "desc", {
      lore: "old lore",
      tags: ["old"],
    });
    const updated = await store.updateWorld(world.id, { lore: "new lore" });
    expect(updated!.lore).toBe("new lore");
    expect(updated!.name).toBe("Partial");
    expect(updated!.tags).toEqual(["old"]);
  });
});

// ─── Sessions ────────────────────────────────────────────────────────────────

describe("MemoryStore — Sessions", () => {
  /** createSession creates a session with a human-readable ID. */
  it("should create a session with worldId", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    expect(session.id).toBeTruthy();
    expect(session.worldId).toBe(world.id);
    expect(session.status).toBe("active");
    expect(session.phase).toBe("init");
    expect(session.createdAt).toBeTruthy();
  });

  /** createSession stores presetId and taskBindings. */
  it("should create a session with presetId and taskBindings", async () => {
    const world = await store.createWorld("W", "d");
    const bindings = { narrator: "slot-a", combat: "slot-b" };
    const session = await store.createSession({
      worldId: world.id,
      presetId: "custom-preset",
      taskBindings: bindings,
    });
    expect(session.presetId).toBe("custom-preset");
    expect(session.taskBindings).toEqual(bindings);
  });

  /** listSessions filters by worldId. */
  it("should list sessions filtered by worldId", async () => {
    const w1 = await store.createWorld("W1", "d");
    const w2 = await store.createWorld("W2", "d");
    await store.createSession({ worldId: w1.id });
    await store.createSession({ worldId: w1.id });
    await store.createSession({ worldId: w2.id });

    const sessions1 = await store.listSessions(w1.id);
    const sessions2 = await store.listSessions(w2.id);
    expect(sessions1).toHaveLength(2);
    expect(sessions2).toHaveLength(1);
    expect(sessions1.every((s) => s.worldId === w1.id)).toBe(true);
  });

  /** listSessions returns empty array for unknown worldId. */
  it("should return empty array for unknown worldId", async () => {
    const sessions = await store.listSessions("nonexistent-world");
    expect(sessions).toEqual([]);
  });

  /** getSession returns a session by ID. */
  it("should get a session by ID", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const fetched = await store.getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(session.id);
  });

  /** getSession returns undefined for non-existent ID. */
  it("should return undefined for non-existent session", async () => {
    expect(await store.getSession("nonexistent")).toBeUndefined();
  });

  /** updateSession patches status and phase fields. */
  it("should update session status and phase", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const updated = await store.updateSession(session.id, {
      status: "waiting_for_input",
      phase: "playing",
    });
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("waiting_for_input");
    expect(updated!.phase).toBe("playing");
  });

  /** updateSession returns undefined for non-existent session. */
  it("should return undefined when updating non-existent session", async () => {
    const result = await store.updateSession("nonexistent", { phase: "ended" });
    expect(result).toBeUndefined();
  });

  /** updateSession patches presetId and taskBindings. */
  it("should update session presetId and taskBindings", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const updated = await store.updateSession(session.id, {
      presetId: "new-preset",
      taskBindings: { key: "value" },
    });
    expect(updated!.presetId).toBe("new-preset");
    expect(updated!.taskBindings).toEqual({ key: "value" });
  });

  /** updateSessionPhase is a shorthand for updating just the phase. */
  it("should update session phase via shorthand", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const updated = await store.updateSessionPhase(session.id, "character_creation");
    expect(updated).toBeDefined();
    expect(updated!.phase).toBe("character_creation");
    // status should remain unchanged
    expect(updated!.status).toBe("active");
  });

  /** updateSessionPhase returns undefined for non-existent session. */
  it("should return undefined for updateSessionPhase on non-existent session", async () => {
    const result = await store.updateSessionPhase("nonexistent", "ended");
    expect(result).toBeUndefined();
  });
});

// ─── Messages ────────────────────────────────────────────────────────────────

describe("MemoryStore — Messages", () => {
  /** addMessage creates a message with generated ID. */
  it("should add a message with generated ID", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const msg = await store.addMessage(session.id, "user", "Hello world");
    expect(msg.id).toBeTruthy();
    expect(msg.id).toMatch(/^msg_/);
    expect(msg.sessionId).toBe(session.id);
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello world");
    expect(msg.createdAt).toBeTruthy();
  });

  /** listMessages returns messages filtered by sessionId. */
  it("should list messages by sessionId", async () => {
    const world = await store.createWorld("W", "d");
    const s1 = await store.createSession({ worldId: world.id });
    const s2 = await store.createSession({ worldId: world.id });

    await store.addMessage(s1.id, "user", "msg1");
    await store.addMessage(s1.id, "assistant", "msg2");
    await store.addMessage(s2.id, "user", "msg3");

    const msgs1 = await store.listMessages(s1.id);
    const msgs2 = await store.listMessages(s2.id);
    expect(msgs1).toHaveLength(2);
    expect(msgs2).toHaveLength(1);
  });

  /** listMessages returns empty for unknown session. */
  it("should return empty array for unknown sessionId", async () => {
    const msgs = await store.listMessages("nonexistent-session");
    expect(msgs).toEqual([]);
  });

  /** Messages include turnId, runtimeId, and block metadata. */
  it("should store turnId, runtimeId, and block metadata", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });

    const msg = await store.addMessage(session.id, "assistant", "narrative text", {
      turnId: "turn-1",
      runtimeId: "runtime-1",
      block: { type: "narrative", style: "dramatic" },
    });

    expect(msg.turnId).toBe("turn-1");
    expect(msg.runtimeId).toBe("runtime-1");
    expect(msg.block).toEqual({ type: "narrative", style: "dramatic" });
  });

  /** Messages without optional meta omit those fields. */
  it("should omit optional meta when not provided", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const msg = await store.addMessage(session.id, "user", "plain");
    expect(msg.turnId).toBeUndefined();
    expect(msg.runtimeId).toBeUndefined();
    expect(msg.block).toBeUndefined();
  });
});

// ─── State Patches ───────────────────────────────────────────────────────────

describe("MemoryStore — State Patches", () => {
  /** addStatePatch stores a patch and returns it. */
  it("should add a state patch", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });

    const patch = await store.addStatePatch(session.id, {
      id: "patch-1",
      summary: "HP decreased",
      packageName: "core-combat",
      data: { hp: { old: 100, new: 80 } },
    });

    expect(patch.id).toBe("patch-1");
    expect(patch.sessionId).toBe(session.id);
    expect(patch.summary).toBe("HP decreased");
    expect(patch.packageName).toBe("core-combat");
    expect(patch.data).toEqual({ hp: { old: 100, new: 80 } });
    expect(patch.createdAt).toBeTruthy();
  });

  /** listStatePatches returns patches for a given sessionId. */
  it("should list state patches by sessionId", async () => {
    const world = await store.createWorld("W", "d");
    const s1 = await store.createSession({ worldId: world.id });
    const s2 = await store.createSession({ worldId: world.id });

    await store.addStatePatch(s1.id, { id: "p1", summary: "s1", packageName: "pkg" });
    await store.addStatePatch(s1.id, { id: "p2", summary: "s2", packageName: "pkg" });
    await store.addStatePatch(s2.id, { id: "p3", summary: "s3", packageName: "pkg" });

    const patches1 = await store.listStatePatches(s1.id);
    const patches2 = await store.listStatePatches(s2.id);
    expect(patches1).toHaveLength(2);
    expect(patches2).toHaveLength(1);
  });

  /** listStatePatches returns empty for unknown session. */
  it("should return empty array for unknown sessionId", async () => {
    const patches = await store.listStatePatches("nonexistent");
    expect(patches).toEqual([]);
  });
});

// ─── Characters ──────────────────────────────────────────────────────────────

describe("MemoryStore — Characters", () => {
  /** createCharacter requires a valid session. */
  it("should create a character for a valid session", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });

    const char = await store.createCharacter(session.id, {
      name: "Hero",
      type: "player",
      description: "A brave warrior",
      fields: { hp: 100, strength: 15 },
    });

    expect(char.id).toBeTruthy();
    expect(char.id).toMatch(/^char_/);
    expect(char.name).toBe("Hero");
    expect(char.type).toBe("player");
    expect(char.description).toBe("A brave warrior");
    expect(char.fields).toEqual({ hp: 100, strength: 15 });
    expect(char.worldId).toBe(world.id);
    expect(char.runId).toBe(session.id);
    expect(char.version).toBe(1);
    expect(char.createdAt).toBeTruthy();
  });

  /** createCharacter throws for an invalid sessionId. */
  it("should throw for invalid sessionId", async () => {
    await expect(
      store.createCharacter("nonexistent-session", { name: "Ghost" })
    ).rejects.toThrow("Session not found");
  });

  /** createCharacter defaults type to "player" when not specified. */
  it("should default type to player", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const char = await store.createCharacter(session.id, { name: "Default" });
    expect(char.type).toBe("player");
  });

  /** getCharacter returns the character by ID. */
  it("should get a character by ID", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const created = await store.createCharacter(session.id, { name: "Lookup" });

    const fetched = await store.getCharacter(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("Lookup");
  });

  /** getCharacter returns undefined for non-existent ID. */
  it("should return undefined for non-existent character", async () => {
    expect(await store.getCharacter("nonexistent")).toBeUndefined();
  });

  /** getSessionCharacters filters characters by sessionId. */
  it("should get characters filtered by sessionId", async () => {
    const world = await store.createWorld("W", "d");
    const s1 = await store.createSession({ worldId: world.id });
    const s2 = await store.createSession({ worldId: world.id });

    await store.createCharacter(s1.id, { name: "Hero1" });
    await store.createCharacter(s1.id, { name: "Hero2" });
    await store.createCharacter(s2.id, { name: "Villain" });

    const chars1 = await store.getSessionCharacters(s1.id);
    const chars2 = await store.getSessionCharacters(s2.id);
    expect(chars1).toHaveLength(2);
    expect(chars2).toHaveLength(1);
    expect(chars1.every((c) => c.runId === s1.id)).toBe(true);
  });

  /** getSessionCharacters returns empty for unknown session. */
  it("should return empty array for unknown sessionId", async () => {
    const chars = await store.getSessionCharacters("nonexistent");
    expect(chars).toEqual([]);
  });

  /** updateCharacter patches fields and increments version. */
  it("should update character and increment version", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const char = await store.createCharacter(session.id, {
      name: "Hero",
      fields: { hp: 100 },
    });
    expect(char.version).toBe(1);

    const updated = await store.updateCharacter(char.id, {
      name: "Updated Hero",
      fields: { hp: 80 },
    });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe("Updated Hero");
    expect(updated!.fields).toEqual({ hp: 80 });
    expect(updated!.version).toBe(2);
  });

  /** updateCharacter returns undefined for non-existent character. */
  it("should return undefined when updating non-existent character", async () => {
    const result = await store.updateCharacter("nonexistent", { name: "Nope" });
    expect(result).toBeUndefined();
  });

  /** updateCharacter only patches provided fields. */
  it("should partially update character fields", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const char = await store.createCharacter(session.id, {
      name: "Original",
      description: "original desc",
      fields: { hp: 100 },
    });

    const updated = await store.updateCharacter(char.id, { description: "new desc" });
    expect(updated!.name).toBe("Original");
    expect(updated!.description).toBe("new desc");
    expect(updated!.fields).toEqual({ hp: 100 });
    expect(updated!.version).toBe(2);
  });

  /** Multiple updates each increment version by 1. */
  it("should increment version on each update", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const char = await store.createCharacter(session.id, { name: "V" });

    await store.updateCharacter(char.id, { name: "V2" });
    const v3 = await store.updateCharacter(char.id, { name: "V3" });
    expect(v3!.version).toBe(3);
  });
});

// ─── Trace Events ────────────────────────────────────────────────────────────

describe("MemoryStore — Trace Events", () => {
  function makeTraceEvent(
    sessionId: string,
    overrides?: Partial<{ type: string; seq: number }>
  ) {
    return {
      type: overrides?.type ?? "message.completed",
      requestId: "req-1",
      traceId: "trace-1",
      sessionId,
      turnId: "turn-1",
      flowId: "flow-1",
      seq: overrides?.seq ?? 0,
      timestamp: new Date().toISOString(),
      payload: { content: "test" },
    };
  }

  /** addTraceEvent stores an event for a session. */
  it("should add and list trace events", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });
    const event = makeTraceEvent(session.id);

    await store.addTraceEvent(session.id, event);
    const events = await store.listTraceEvents(session.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message.completed");
  });

  /** listTraceEvents returns empty for unknown session. */
  it("should return empty array for unknown sessionId", async () => {
    const events = await store.listTraceEvents("nonexistent");
    expect(events).toEqual([]);
  });

  /** Multiple events for the same session accumulate. */
  it("should accumulate events for the same session", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });

    await store.addTraceEvent(session.id, makeTraceEvent(session.id, { seq: 0 }));
    await store.addTraceEvent(session.id, makeTraceEvent(session.id, { seq: 1 }));
    await store.addTraceEvent(session.id, makeTraceEvent(session.id, { seq: 2 }));

    const events = await store.listTraceEvents(session.id);
    expect(events).toHaveLength(3);
  });

  /** Trace events are capped at MAX_TRACE_EVENTS_PER_SESSION (2000). */
  it("should cap trace events at MAX_TRACE_EVENTS_PER_SESSION", async () => {
    const world = await store.createWorld("W", "d");
    const session = await store.createSession({ worldId: world.id });

    // Add 2010 events to exceed the 2000 cap
    const addPromises = Array.from({ length: 2010 }, (_, i) =>
      store.addTraceEvent(session.id, makeTraceEvent(session.id, { seq: i }))
    );
    // Execute sequentially to ensure ordering
    for (const p of addPromises) {
      await p;
    }

    const events = await store.listTraceEvents(session.id);
    expect(events).toHaveLength(2000);
    // The oldest events (seq 0-9) should have been evicted
    expect(events[0].seq).toBe(10);
    expect(events[events.length - 1].seq).toBe(2009);
  });

  /** Events from different sessions are isolated. */
  it("should isolate events across sessions", async () => {
    const world = await store.createWorld("W", "d");
    const s1 = await store.createSession({ worldId: world.id });
    const s2 = await store.createSession({ worldId: world.id });

    await store.addTraceEvent(s1.id, makeTraceEvent(s1.id, { type: "a" }));
    await store.addTraceEvent(s2.id, makeTraceEvent(s2.id, { type: "b" }));

    const e1 = await store.listTraceEvents(s1.id);
    const e2 = await store.listTraceEvents(s2.id);
    expect(e1).toHaveLength(1);
    expect(e1[0].type).toBe("a");
    expect(e2).toHaveLength(1);
    expect(e2[0].type).toBe("b");
  });
});
