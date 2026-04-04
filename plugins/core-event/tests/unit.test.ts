import { describe, it, expect } from "vitest";
import {
  createEvent,
  evolveEvent,
  resolveEvent,
  endEvent,
  getActiveEvents,
  getEventsByType,
  getChildEvents,
  buildEventTree,
  getEventSummary,
  EMPTY_STATE,
} from "../server/event-logic.js";
import {
  createEventTool,
  evolveEventTool,
  resolveEventTool,
  endEventTool,
} from "../server/tools.js";
import { eventContextProvider } from "../server/context-provider.js";
import type { ToolExecutionContext } from "@covel/shared";

// ── Helpers ──────────────────────────────────────────────────

let idCounter = 0;
function deterministicId(): string {
  idCounter += 1;
  return `test-id-${idCounter}`;
}

function resetIds(): void {
  idCounter = 0;
}

function makeToolCtx(
  input: unknown,
  locale = "en-US",
  state?: Record<string, unknown>,
): ToolExecutionContext {
  return {
    input,
    runtimeId: "event-tracker",
    pluginId: "core-event",
    locale,
    state,
  };
}

// ── event-logic unit tests ──────────────────────────────────

describe("event-logic", () => {
  describe("createEvent", () => {
    it("creates an event with active status and generated ID", () => {
      resetIds();
      const now = "2024-01-01T00:00:00.000Z";
      const { state, event } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Dragon Attack",
          description: "A dragon attacks the village",
          source: "core-narrator",
        },
        deterministicId,
        now,
      );

      expect(event.eventId).toBe("test-id-1");
      expect(event.status).toBe("active");
      expect(event.eventType).toBe("quest");
      expect(event.name).toBe("Dragon Attack");
      expect(event.description).toBe("A dragon attacks the village");
      expect(event.source).toBe("core-narrator");
      expect(event.visibility).toBe("known");
      expect(event.createdAt).toBe(now);
      expect(event.updatedAt).toBe(now);
      expect(event.parentEventId).toBeUndefined();

      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toEqual(event);
    });

    it("creates an event with parent and custom visibility", () => {
      resetIds();
      const { state: s1 } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Parent Event",
          description: "Parent",
          source: "core-narrator",
        },
        deterministicId,
      );

      const { state: s2, event } = createEvent(
        s1,
        {
          eventType: "combat",
          name: "Child Event",
          description: "Child",
          source: "core-combat",
          parentEventId: "test-id-1",
          visibility: "hidden",
        },
        deterministicId,
      );

      expect(event.parentEventId).toBe("test-id-1");
      expect(event.visibility).toBe("hidden");
      expect(s2.events).toHaveLength(2);
    });

    it("preserves existing events immutably", () => {
      resetIds();
      const { state: s1 } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "First",
          description: "First event",
          source: "core-narrator",
        },
        deterministicId,
      );

      const { state: s2 } = createEvent(
        s1,
        {
          eventType: "social",
          name: "Second",
          description: "Second event",
          source: "core-narrator",
        },
        deterministicId,
      );

      // Original state unchanged
      expect(s1.events).toHaveLength(1);
      expect(s2.events).toHaveLength(2);
      expect(s2.events[0].name).toBe("First");
      expect(s2.events[1].name).toBe("Second");
    });
  });

  describe("evolveEvent", () => {
    it("updates description and updatedAt for active event", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Dragon Attack",
          description: "A dragon appears",
          source: "core-narrator",
        },
        deterministicId,
        "2024-01-01T00:00:00.000Z",
      );

      const now = "2024-01-01T01:00:00.000Z";
      const evolved = evolveEvent(
        state,
        "test-id-1",
        "The dragon burns the village",
        now,
      );

      const event = evolved.events[0];
      expect(event.status).toBe("evolved");
      expect(event.description).toBe("The dragon burns the village");
      expect(event.updatedAt).toBe(now);
      // Name unchanged
      expect(event.name).toBe("Dragon Attack");
    });

    it("can evolve an already evolved event", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Initial",
          source: "core-narrator",
        },
        deterministicId,
      );

      const s2 = evolveEvent(state, "test-id-1", "Second stage");
      const s3 = evolveEvent(s2, "test-id-1", "Third stage");

      expect(s3.events[0].description).toBe("Third stage");
      expect(s3.events[0].status).toBe("evolved");
    });

    it("throws for nonexistent event", () => {
      expect(() => evolveEvent(EMPTY_STATE, "nope", "desc")).toThrow(
        "Event not found: nope",
      );
    });

    it("throws for resolved event", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Desc",
          source: "core-narrator",
        },
        deterministicId,
      );

      const resolved = resolveEvent(state, "test-id-1");
      expect(() => evolveEvent(resolved, "test-id-1", "New desc")).toThrow(
        "Cannot evolve event test-id-1 with status resolved",
      );
    });

    it("throws for ended event", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Desc",
          source: "core-narrator",
        },
        deterministicId,
      );

      const ended = endEvent(state, "test-id-1");
      expect(() => evolveEvent(ended, "test-id-1", "New desc")).toThrow(
        "Cannot evolve event test-id-1 with status ended",
      );
    });
  });

  describe("resolveEvent", () => {
    it("sets status to resolved for active event", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Desc",
          source: "core-narrator",
        },
        deterministicId,
        "2024-01-01T00:00:00.000Z",
      );

      const now = "2024-01-01T02:00:00.000Z";
      const resolved = resolveEvent(state, "test-id-1", "The dragon was defeated", now);
      const event = resolved.events[0];

      expect(event.status).toBe("resolved");
      expect(event.description).toBe("The dragon was defeated");
      expect(event.updatedAt).toBe(now);
    });

    it("resolves an evolved event", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Desc",
          source: "core-narrator",
        },
        deterministicId,
      );

      const evolved = evolveEvent(state, "test-id-1", "Evolved desc");
      const resolved = resolveEvent(evolved, "test-id-1");

      expect(resolved.events[0].status).toBe("resolved");
    });

    it("keeps original description when no resolution provided", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Original desc",
          source: "core-narrator",
        },
        deterministicId,
      );

      const resolved = resolveEvent(state, "test-id-1");
      expect(resolved.events[0].description).toBe("Original desc");
    });

    it("throws for nonexistent event", () => {
      expect(() => resolveEvent(EMPTY_STATE, "nope")).toThrow(
        "Event not found: nope",
      );
    });

    it("throws for already resolved event", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Desc",
          source: "core-narrator",
        },
        deterministicId,
      );

      const resolved = resolveEvent(state, "test-id-1");
      expect(() => resolveEvent(resolved, "test-id-1")).toThrow(
        "Cannot resolve event test-id-1 with status resolved",
      );
    });

    it("throws for ended event", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Desc",
          source: "core-narrator",
        },
        deterministicId,
      );

      const ended = endEvent(state, "test-id-1");
      expect(() => resolveEvent(ended, "test-id-1")).toThrow(
        "Cannot resolve event test-id-1 with status ended",
      );
    });
  });

  describe("endEvent", () => {
    it("sets status to ended for active event", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Desc",
          source: "core-narrator",
        },
        deterministicId,
        "2024-01-01T00:00:00.000Z",
      );

      const now = "2024-01-01T03:00:00.000Z";
      const ended = endEvent(state, "test-id-1", "Player left the area", now);
      const event = ended.events[0];

      expect(event.status).toBe("ended");
      expect(event.description).toBe("Player left the area");
      expect(event.updatedAt).toBe(now);
    });

    it("ends a resolved event", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Desc",
          source: "core-narrator",
        },
        deterministicId,
      );

      const resolved = resolveEvent(state, "test-id-1");
      const ended = endEvent(resolved, "test-id-1");

      expect(ended.events[0].status).toBe("ended");
    });

    it("throws for nonexistent event", () => {
      expect(() => endEvent(EMPTY_STATE, "nope")).toThrow(
        "Event not found: nope",
      );
    });

    it("throws for already ended event", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Desc",
          source: "core-narrator",
        },
        deterministicId,
      );

      const ended = endEvent(state, "test-id-1");
      expect(() => endEvent(ended, "test-id-1")).toThrow(
        "Cannot end event test-id-1 with status ended",
      );
    });
  });

  describe("getActiveEvents", () => {
    it("returns active and evolved events", () => {
      resetIds();
      const { state: s1 } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Active",
          description: "Active event",
          source: "core-narrator",
        },
        deterministicId,
      );

      const { state: s2 } = createEvent(
        s1,
        {
          eventType: "combat",
          name: "Evolved",
          description: "Will evolve",
          source: "core-combat",
        },
        deterministicId,
      );

      const { state: s3 } = createEvent(
        s2,
        {
          eventType: "social",
          name: "Resolved",
          description: "Will resolve",
          source: "core-narrator",
        },
        deterministicId,
      );

      const s4 = evolveEvent(s3, "test-id-2", "Evolved desc");
      const s5 = resolveEvent(s4, "test-id-3");

      const active = getActiveEvents(s5);
      expect(active).toHaveLength(2);
      expect(active[0].name).toBe("Active");
      expect(active[1].name).toBe("Evolved");
    });

    it("returns empty array for empty state", () => {
      expect(getActiveEvents(EMPTY_STATE)).toHaveLength(0);
    });
  });

  describe("getEventsByType", () => {
    it("filters events by type", () => {
      resetIds();
      const { state: s1 } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Quest Event",
          description: "Quest",
          source: "core-narrator",
        },
        deterministicId,
      );

      const { state: s2 } = createEvent(
        s1,
        {
          eventType: "combat",
          name: "Combat Event",
          description: "Combat",
          source: "core-combat",
        },
        deterministicId,
      );

      const { state: s3 } = createEvent(
        s2,
        {
          eventType: "quest",
          name: "Another Quest",
          description: "Quest 2",
          source: "core-narrator",
        },
        deterministicId,
      );

      const quests = getEventsByType(s3, "quest");
      expect(quests).toHaveLength(2);
      expect(quests[0].name).toBe("Quest Event");
      expect(quests[1].name).toBe("Another Quest");

      const combats = getEventsByType(s3, "combat");
      expect(combats).toHaveLength(1);
    });
  });

  describe("getChildEvents", () => {
    it("returns child events for a parent", () => {
      resetIds();
      const { state: s1 } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Parent",
          description: "Parent event",
          source: "core-narrator",
        },
        deterministicId,
      );

      const { state: s2 } = createEvent(
        s1,
        {
          eventType: "combat",
          name: "Child 1",
          description: "Child event 1",
          source: "core-combat",
          parentEventId: "test-id-1",
        },
        deterministicId,
      );

      const { state: s3 } = createEvent(
        s2,
        {
          eventType: "social",
          name: "Child 2",
          description: "Child event 2",
          source: "core-narrator",
          parentEventId: "test-id-1",
        },
        deterministicId,
      );

      const { state: s4 } = createEvent(
        s3,
        {
          eventType: "world",
          name: "Unrelated",
          description: "Not a child",
          source: "core-narrator",
        },
        deterministicId,
      );

      const children = getChildEvents(s4, "test-id-1");
      expect(children).toHaveLength(2);
      expect(children[0].name).toBe("Child 1");
      expect(children[1].name).toBe("Child 2");
    });

    it("returns empty array when no children exist", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Lone Event",
          description: "No children",
          source: "core-narrator",
        },
        deterministicId,
      );

      expect(getChildEvents(state, "test-id-1")).toHaveLength(0);
    });
  });

  describe("buildEventTree", () => {
    it("builds hierarchical tree from flat events", () => {
      resetIds();
      const { state: s1 } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Root 1",
          description: "Root event",
          source: "core-narrator",
        },
        deterministicId,
      );

      const { state: s2 } = createEvent(
        s1,
        {
          eventType: "combat",
          name: "Child of Root 1",
          description: "Child",
          source: "core-combat",
          parentEventId: "test-id-1",
        },
        deterministicId,
      );

      const { state: s3 } = createEvent(
        s2,
        {
          eventType: "social",
          name: "Root 2",
          description: "Another root",
          source: "core-narrator",
        },
        deterministicId,
      );

      const tree = buildEventTree(s3);
      expect(tree).toHaveLength(2);
      expect(tree[0].event.name).toBe("Root 1");
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].event.name).toBe("Child of Root 1");
      expect(tree[1].event.name).toBe("Root 2");
      expect(tree[1].children).toHaveLength(0);
    });

    it("returns empty array for empty state", () => {
      expect(buildEventTree(EMPTY_STATE)).toHaveLength(0);
    });
  });

  describe("getEventSummary", () => {
    it("returns no-event message for empty state (en)", () => {
      expect(getEventSummary(EMPTY_STATE, "en-US")).toBe("No active events.");
    });

    it("returns no-event message for empty state (zh)", () => {
      expect(getEventSummary(EMPTY_STATE, "zh-CN")).toBe(
        "当前没有进行中的事件。",
      );
    });

    it("formats active events with type labels (en)", () => {
      resetIds();
      const { state: s1 } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Find Gem",
          description: "Locate the gem",
          source: "core-narrator",
        },
        deterministicId,
      );

      const { state: s2 } = createEvent(
        s1,
        {
          eventType: "combat",
          name: "Dragon Fight",
          description: "Fight the dragon",
          source: "core-combat",
        },
        deterministicId,
      );

      const summary = getEventSummary(s2, "en-US");
      expect(summary).toContain("[Quest][active] Find Gem");
      expect(summary).toContain("[Combat][active] Dragon Fight");
    });

    it("formats active events with type labels (zh)", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "寻找宝石",
          description: "找到隐藏的宝石",
          source: "core-narrator",
        },
        deterministicId,
      );

      const summary = getEventSummary(state, "zh-CN");
      expect(summary).toContain("[任务][进行中] 寻找宝石");
    });

    it("shows evolved events", () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "world",
          name: "Storm",
          description: "A storm is coming",
          source: "core-narrator",
        },
        deterministicId,
      );

      const evolved = evolveEvent(state, "test-id-1", "The storm intensifies");
      const summary = getEventSummary(evolved, "en-US");
      expect(summary).toContain("[World][evolved] Storm");
    });

    it("excludes resolved and ended events", () => {
      resetIds();
      const { state: s1 } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Active Event",
          description: "Active",
          source: "core-narrator",
        },
        deterministicId,
      );

      const { state: s2 } = createEvent(
        s1,
        {
          eventType: "combat",
          name: "Resolved Event",
          description: "Resolved",
          source: "core-combat",
        },
        deterministicId,
      );

      const s3 = resolveEvent(s2, "test-id-2");
      const summary = getEventSummary(s3, "en-US");
      expect(summary).toContain("Active Event");
      expect(summary).not.toContain("Resolved Event");
    });
  });
});

// ── Tool wrapper tests ──────────────────────────────────────

describe("tools", () => {
  describe("createEventTool", () => {
    it("returns proposals with state.patch, record.upsert, event.emit", async () => {
      const result = await createEventTool(
        makeToolCtx({
          eventType: "quest",
          name: "Test Event",
          description: "A test event",
          source: "core-narrator",
        }),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("eventId");
      expect(output).toHaveProperty("message");
      expect(result.proposals).toHaveLength(3);

      const kinds = result.proposals!.map((p) => p.kind);
      expect(kinds).toContain("state.patch");
      expect(kinds).toContain("record.upsert");
      expect(kinds).toContain("event.emit");

      const eventProposal = result.proposals!.find(
        (p) => p.kind === "event.emit",
      );
      expect((eventProposal?.payload as Record<string, unknown>).type).toBe(
        "game_event_created",
      );
    });

    it("returns zh-CN message for Chinese locale", async () => {
      const result = await createEventTool(
        makeToolCtx(
          {
            eventType: "quest",
            name: "测试事件",
            description: "一个测试事件",
            source: "core-narrator",
          },
          "zh-CN",
        ),
      );

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("已创建事件");
      expect(msg).toContain("测试事件");
    });

    it("includes record.upsert with event data", async () => {
      const result = await createEventTool(
        makeToolCtx({
          eventType: "combat",
          name: "Battle Start",
          description: "A fierce battle begins",
          source: "core-combat",
          visibility: "hidden",
        }),
      );

      const record = result.proposals!.find((p) => p.kind === "record.upsert");
      const payload = record?.payload as Record<string, unknown>;
      expect(payload.recordType).toBe("event");

      const value = payload.value as Record<string, unknown>;
      expect(value.name).toBe("Battle Start");
      expect(value.eventType).toBe("combat");
      expect(value.visibility).toBe("hidden");
      expect(value.status).toBe("active");
    });

    it("returns error for invalid input", async () => {
      const result = await createEventTool(
        makeToolCtx({ invalid: true }),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("error");
      expect(result.proposals).toBeUndefined();
    });

    it("creates event with parent ID", async () => {
      const result = await createEventTool(
        makeToolCtx({
          eventType: "combat",
          name: "Sub Battle",
          description: "A sub-battle",
          source: "core-combat",
          parentEventId: "parent-123",
        }),
      );

      const record = result.proposals!.find((p) => p.kind === "record.upsert");
      const value = (record?.payload as Record<string, unknown>).value as Record<string, unknown>;
      expect(value.parentEventId).toBe("parent-123");
    });
  });

  describe("evolveEventTool", () => {
    it("returns state.patch and record.upsert proposals", async () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Initial",
          source: "core-narrator",
        },
        deterministicId,
      );

      const result = await evolveEventTool(
        makeToolCtx(
          { eventId: "test-id-1", description: "Evolved description" },
          "en-US",
          { "core-event": state },
        ),
      );

      const output = result.output as Record<string, unknown>;
      expect(output.message).toContain("test-id-1");
      expect(result.proposals).toHaveLength(2);

      const kinds = result.proposals!.map((p) => p.kind);
      expect(kinds).toContain("state.patch");
      expect(kinds).toContain("record.upsert");
    });

    it("returns zh-CN message for Chinese locale", async () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Initial",
          source: "core-narrator",
        },
        deterministicId,
      );

      const result = await evolveEventTool(
        makeToolCtx(
          { eventId: "test-id-1", description: "New desc" },
          "zh-CN",
          { "core-event": state },
        ),
      );

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("已演变");
    });

    it("returns error for nonexistent event", async () => {
      const result = await evolveEventTool(
        makeToolCtx(
          { eventId: "nope", description: "desc" },
          "en-US",
          {},
        ),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("error");
    });
  });

  describe("resolveEventTool", () => {
    it("returns state.patch, record.upsert, and event.emit proposals", async () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Initial",
          source: "core-narrator",
        },
        deterministicId,
      );

      const result = await resolveEventTool(
        makeToolCtx(
          { eventId: "test-id-1", resolution: "The quest was completed" },
          "en-US",
          { "core-event": state },
        ),
      );

      expect(result.proposals).toHaveLength(3);

      const kinds = result.proposals!.map((p) => p.kind);
      expect(kinds).toContain("state.patch");
      expect(kinds).toContain("record.upsert");
      expect(kinds).toContain("event.emit");

      const eventProposal = result.proposals!.find(
        (p) => p.kind === "event.emit",
      );
      expect((eventProposal?.payload as Record<string, unknown>).type).toBe(
        "game_event_resolved",
      );
    });

    it("returns zh-CN message", async () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Initial",
          source: "core-narrator",
        },
        deterministicId,
      );

      const result = await resolveEventTool(
        makeToolCtx(
          { eventId: "test-id-1" },
          "zh-CN",
          { "core-event": state },
        ),
      );

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("已解决");
    });
  });

  describe("endEventTool", () => {
    it("returns state.patch and record.upsert proposals", async () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Initial",
          source: "core-narrator",
        },
        deterministicId,
      );

      const result = await endEventTool(
        makeToolCtx(
          { eventId: "test-id-1", reason: "Player fled" },
          "en-US",
          { "core-event": state },
        ),
      );

      expect(result.proposals).toHaveLength(2);
      const kinds = result.proposals!.map((p) => p.kind);
      expect(kinds).toContain("state.patch");
      expect(kinds).toContain("record.upsert");

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("test-id-1");
    });

    it("returns zh-CN message", async () => {
      resetIds();
      const { state } = createEvent(
        EMPTY_STATE,
        {
          eventType: "quest",
          name: "Event",
          description: "Initial",
          source: "core-narrator",
        },
        deterministicId,
      );

      const result = await endEventTool(
        makeToolCtx(
          { eventId: "test-id-1" },
          "zh-CN",
          { "core-event": state },
        ),
      );

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("已结束");
    });

    it("returns error for nonexistent event", async () => {
      const result = await endEventTool(
        makeToolCtx(
          { eventId: "nope" },
          "en-US",
          {},
        ),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("error");
    });
  });
});

// ── Context provider tests ──────────────────────────────────

describe("eventContextProvider", () => {
  it("returns empty event message for no events", async () => {
    const result = (await eventContextProvider({
      pluginId: "core-event",
      runtimeId: "event-tracker",
      locale: "en-US",
      state: {},
    })) as Record<string, unknown>;

    expect(result.content).toBe("No active events.");
  });

  it("returns event summary for active events", async () => {
    resetIds();
    const { state } = createEvent(
      EMPTY_STATE,
      {
        eventType: "quest",
        name: "Find Gem",
        description: "Locate the gem",
        source: "core-narrator",
      },
      deterministicId,
    );

    const result = (await eventContextProvider({
      pluginId: "core-event",
      runtimeId: "event-tracker",
      locale: "en-US",
      state: { "core-event": state },
    })) as Record<string, unknown>;

    expect((result.content as string)).toContain("Find Gem");
    expect(result.priority).toBe(65);
  });

  it("returns zh-CN content for Chinese locale", async () => {
    const result = (await eventContextProvider({
      pluginId: "core-event",
      runtimeId: "event-tracker",
      locale: "zh-CN",
      state: {},
    })) as Record<string, unknown>;

    expect(result.title).toBe("当前事件时间线");
    expect(result.content).toBe("当前没有进行中的事件。");
  });
});
