import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { validateManifest } from "@covel/plugin-runtime";
import {
  createQuest,
  updateQuest,
  completeObjective,
  completeQuest,
  failQuest,
  getActiveQuests,
  getQuestSummary,
  EMPTY_STATE,
} from "../server/quest-logic.js";
import {
  createQuestTool,
  updateQuestTool,
  completeObjectiveTool,
  completeQuestTool,
  failQuestTool,
} from "../server/tools.js";
import { questContextProvider } from "../server/context-provider.js";
import type { ToolExecutionContext } from "@covel/shared";

// ── plugin.json manifest ────────────────────────────────────────

describe("plugin.json manifest", () => {
  it("passes schema validation", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const result = validateManifest(raw);
    if (!result.ok) {
      throw new Error(
        `Manifest validation failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});

// ── Helpers ──────────────────────────────────────────────────

let idCounter = 0;
function deterministicId(): string {
  idCounter += 1;
  return `test-id-${idCounter}`;
}

function resetIds(): void {
  idCounter = 0;
}

function makeToolCtx(input: unknown, locale = "en-US", state?: Record<string, unknown>): ToolExecutionContext {
  return {
    input,
    runtimeId: "quest-tracker",
    pluginId: "core-quest",
    locale,
    state,
  };
}

/** State with one active quest (quest-123) containing one objective (obj-456). */
function stateWithQuest(): Record<string, unknown> {
  return {
    quests: [
      {
        id: "quest-123",
        title: "Test Quest",
        description: "A quest",
        type: "main",
        status: "active",
        objectives: [{ id: "obj-456", description: "Test objective", completed: false }],
        createdAt: "turn-0",
      },
    ],
  };
}

// ── quest-logic unit tests ──────────────────────────────────

describe("quest-logic", () => {
  describe("createQuest", () => {
    it("creates a quest with generated IDs and active status", () => {
      resetIds();
      const { state, quest } = createQuest(
        EMPTY_STATE,
        {
          title: "Find the Gem",
          description: "Locate the hidden gem in the cave",
          type: "main",
          objectives: [
            { description: "Enter the cave" },
            { description: "Find the secret room" },
          ],
        },
        "turn-1",
        deterministicId,
      );

      expect(quest.id).toBe("test-id-1");
      expect(quest.status).toBe("active");
      expect(quest.title).toBe("Find the Gem");
      expect(quest.type).toBe("main");
      expect(quest.discoveredTurnId).toBe("turn-1");
      expect(quest.objectives).toHaveLength(2);
      expect(quest.objectives[0].id).toBe("test-id-2");
      expect(quest.objectives[0].completed).toBe(false);
      expect(quest.objectives[1].id).toBe("test-id-3");

      expect(state.quests).toHaveLength(1);
      expect(state.activeQuestId).toBe("test-id-1");
    });

    it("does not overwrite existing activeQuestId", () => {
      resetIds();
      const { state: firstState } = createQuest(
        EMPTY_STATE,
        {
          title: "Quest 1",
          description: "First quest",
          type: "main",
          objectives: [{ description: "Do something" }],
        },
        "turn-1",
        deterministicId,
      );

      const { state: secondState } = createQuest(
        firstState,
        {
          title: "Quest 2",
          description: "Second quest",
          type: "side",
          objectives: [{ description: "Another thing" }],
        },
        "turn-2",
        deterministicId,
      );

      expect(secondState.quests).toHaveLength(2);
      expect(secondState.activeQuestId).toBe("test-id-1");
    });

    it("preserves optional flag on objectives", () => {
      resetIds();
      const { quest } = createQuest(
        EMPTY_STATE,
        {
          title: "Optional Quest",
          description: "A quest with optional objectives",
          type: "side",
          objectives: [
            { description: "Required obj" },
            { description: "Optional obj", optional: true },
          ],
        },
        "turn-1",
        deterministicId,
      );

      expect(quest.objectives[0].optional).toBeUndefined();
      expect(quest.objectives[1].optional).toBe(true);
    });
  });

  describe("updateQuest", () => {
    it("updates title and description", () => {
      resetIds();
      const { state } = createQuest(
        EMPTY_STATE,
        {
          title: "Old Title",
          description: "Old description",
          type: "main",
          objectives: [{ description: "Obj 1" }],
        },
        "turn-1",
        deterministicId,
      );

      const updated = updateQuest(state, "test-id-1", {
        title: "New Title",
        description: "New description",
      });

      const quest = updated.quests.find((q) => q.id === "test-id-1");
      expect(quest?.title).toBe("New Title");
      expect(quest?.description).toBe("New description");
    });

    it("replaces objectives when provided", () => {
      resetIds();
      const { state } = createQuest(
        EMPTY_STATE,
        {
          title: "Quest",
          description: "Desc",
          type: "main",
          objectives: [{ description: "Old obj" }],
        },
        "turn-1",
        deterministicId,
      );

      const updated = updateQuest(
        state,
        "test-id-1",
        {
          objectives: [
            { description: "New obj 1" },
            { description: "New obj 2", optional: true },
          ],
        },
        deterministicId,
      );

      const quest = updated.quests.find((q) => q.id === "test-id-1");
      expect(quest?.objectives).toHaveLength(2);
      expect(quest?.objectives[0].description).toBe("New obj 1");
      expect(quest?.objectives[1].optional).toBe(true);
    });

    it("throws for nonexistent quest", () => {
      expect(() => updateQuest(EMPTY_STATE, "nope", {})).toThrow(
        "Quest not found: nope",
      );
    });
  });

  describe("completeObjective", () => {
    it("marks the specified objective as completed", () => {
      resetIds();
      const { state } = createQuest(
        EMPTY_STATE,
        {
          title: "Quest",
          description: "Desc",
          type: "main",
          objectives: [
            { description: "Obj 1" },
            { description: "Obj 2" },
          ],
        },
        "turn-1",
        deterministicId,
      );

      const updated = completeObjective(state, "test-id-1", "test-id-2");
      const quest = updated.quests.find((q) => q.id === "test-id-1");

      expect(quest?.objectives[0].completed).toBe(true);
      expect(quest?.objectives[1].completed).toBe(false);
    });

    it("throws for nonexistent quest", () => {
      expect(() => completeObjective(EMPTY_STATE, "nope", "obj")).toThrow(
        "Quest not found: nope",
      );
    });

    it("throws for nonexistent objective", () => {
      resetIds();
      const { state } = createQuest(
        EMPTY_STATE,
        {
          title: "Quest",
          description: "Desc",
          type: "main",
          objectives: [{ description: "Obj 1" }],
        },
        "turn-1",
        deterministicId,
      );

      expect(() => completeObjective(state, "test-id-1", "bad-obj")).toThrow(
        "Objective not found: bad-obj in quest test-id-1",
      );
    });
  });

  describe("completeQuest", () => {
    it("sets status to completed with turnId", () => {
      resetIds();
      const { state } = createQuest(
        EMPTY_STATE,
        {
          title: "Quest",
          description: "Desc",
          type: "main",
          objectives: [{ description: "Obj 1" }],
        },
        "turn-1",
        deterministicId,
      );

      const updated = completeQuest(state, "test-id-1", "turn-5");
      const quest = updated.quests.find((q) => q.id === "test-id-1");

      expect(quest?.status).toBe("completed");
      expect(quest?.completedTurnId).toBe("turn-5");
    });

    it("clears activeQuestId when completing the active quest", () => {
      resetIds();
      const { state } = createQuest(
        EMPTY_STATE,
        {
          title: "Quest",
          description: "Desc",
          type: "main",
          objectives: [{ description: "Obj 1" }],
        },
        "turn-1",
        deterministicId,
      );

      expect(state.activeQuestId).toBe("test-id-1");
      const updated = completeQuest(state, "test-id-1", "turn-5");
      expect(updated.activeQuestId).toBeUndefined();
    });

    it("preserves activeQuestId when completing a non-active quest", () => {
      resetIds();
      const { state: s1 } = createQuest(
        EMPTY_STATE,
        {
          title: "Quest 1",
          description: "First",
          type: "main",
          objectives: [{ description: "Obj" }],
        },
        "turn-1",
        deterministicId,
      );

      const { state: s2 } = createQuest(
        s1,
        {
          title: "Quest 2",
          description: "Second",
          type: "side",
          objectives: [{ description: "Obj" }],
        },
        "turn-2",
        deterministicId,
      );

      const secondQuestId = s2.quests[1].id;
      const updated = completeQuest(s2, secondQuestId, "turn-3");
      expect(updated.activeQuestId).toBe("test-id-1");
    });

    it("throws for nonexistent quest", () => {
      expect(() => completeQuest(EMPTY_STATE, "nope", "turn")).toThrow(
        "Quest not found: nope",
      );
    });
  });

  describe("failQuest", () => {
    it("sets status to failed and clears activeQuestId", () => {
      resetIds();
      const { state } = createQuest(
        EMPTY_STATE,
        {
          title: "Quest",
          description: "Desc",
          type: "main",
          objectives: [{ description: "Obj 1" }],
        },
        "turn-1",
        deterministicId,
      );

      const updated = failQuest(state, "test-id-1");
      const quest = updated.quests.find((q) => q.id === "test-id-1");

      expect(quest?.status).toBe("failed");
      expect(updated.activeQuestId).toBeUndefined();
    });

    it("throws for nonexistent quest", () => {
      expect(() => failQuest(EMPTY_STATE, "nope")).toThrow(
        "Quest not found: nope",
      );
    });
  });

  describe("getActiveQuests", () => {
    it("returns only active and discovered quests", () => {
      resetIds();
      const { state: s1 } = createQuest(
        EMPTY_STATE,
        {
          title: "Active Quest",
          description: "Active",
          type: "main",
          objectives: [{ description: "Obj" }],
        },
        "turn-1",
        deterministicId,
      );

      const { state: s2 } = createQuest(
        s1,
        {
          title: "Side Quest",
          description: "Side",
          type: "side",
          objectives: [{ description: "Obj" }],
        },
        "turn-2",
        deterministicId,
      );

      const s3 = completeQuest(s2, s2.quests[0].id, "turn-3");

      const active = getActiveQuests(s3);
      expect(active).toHaveLength(1);
      expect(active[0].title).toBe("Side Quest");
    });

    it("returns empty array for empty state", () => {
      expect(getActiveQuests(EMPTY_STATE)).toHaveLength(0);
    });
  });

  describe("getQuestSummary", () => {
    it("returns no-quest message for empty state (en)", () => {
      expect(getQuestSummary(EMPTY_STATE, "en-US")).toBe("No active quests.");
    });

    it("returns no-quest message for empty state (zh)", () => {
      expect(getQuestSummary(EMPTY_STATE, "zh-CN")).toBe(
        "当前没有进行中的任务。",
      );
    });

    it("formats active quests with objectives", () => {
      resetIds();
      const { state } = createQuest(
        EMPTY_STATE,
        {
          title: "Find Gem",
          description: "Locate the gem",
          type: "main",
          objectives: [
            { description: "Enter cave" },
            { description: "Collect gem", optional: true },
          ],
        },
        "turn-1",
        deterministicId,
      );

      const summary = getQuestSummary(state, "en-US");
      expect(summary).toContain("[Main][active] Find Gem");
      expect(summary).toContain("[ ] Enter cave");
      expect(summary).toContain("[ ] Collect gem (optional)");
    });

    it("shows completed objectives with [x]", () => {
      resetIds();
      const { state } = createQuest(
        EMPTY_STATE,
        {
          title: "Quest",
          description: "Desc",
          type: "main",
          objectives: [
            { description: "Obj 1" },
            { description: "Obj 2" },
          ],
        },
        "turn-1",
        deterministicId,
      );

      const updated = completeObjective(state, "test-id-1", "test-id-2");
      const summary = getQuestSummary(updated, "en-US");
      expect(summary).toContain("[x] Obj 1");
      expect(summary).toContain("[ ] Obj 2");
    });
  });
});

// ── Tool wrapper tests ──────────────────────────────────────

describe("tools", () => {
  describe("createQuestTool", () => {
    it("returns proposals with state.patch, record.upsert, event.emit", async () => {
      const result = await createQuestTool(
        makeToolCtx({
          title: "Test Quest",
          description: "A test quest",
          type: "main",
          objectives: [{ description: "Test objective" }],
        }),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("questId");
      expect(output).toHaveProperty("objectiveIds");
      expect((output.objectiveIds as string[])).toHaveLength(1);
      expect(result.proposals).toHaveLength(3);

      const kinds = result.proposals!.map((p) => p.kind);
      expect(kinds).toContain("state.patch");
      expect(kinds).toContain("record.upsert");
      expect(kinds).toContain("event.emit");

      const eventProposal = result.proposals!.find(
        (p) => p.kind === "event.emit",
      );
      expect((eventProposal?.payload as Record<string, unknown>).type).toBe(
        "quest_discovered",
      );
    });

    it("returns zh-CN message for Chinese locale", async () => {
      const result = await createQuestTool(
        makeToolCtx(
          {
            title: "测试任务",
            description: "一个测试任务",
            type: "main",
            objectives: [{ description: "测试目标" }],
          },
          "zh-CN",
        ),
      );

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("已创建任务");
      expect(msg).toContain("测试任务");
    });

    it("includes record.upsert with quest data", async () => {
      const result = await createQuestTool(
        makeToolCtx({
          title: "Record Quest",
          description: "Test record upsert",
          type: "side",
          objectives: [{ description: "Obj" }],
          rewards: "Gold coins",
          giverNpcId: "merchant",
        }),
      );

      const record = result.proposals!.find((p) => p.kind === "record.upsert");
      const payload = record?.payload as Record<string, unknown>;
      expect(payload.recordType).toBe("quest");

      const value = payload.value as Record<string, unknown>;
      expect(value.title).toBe("Record Quest");
      expect(value.rewards).toBe("Gold coins");
      expect(value.giverNpcId).toBe("merchant");
      expect(value.status).toBe("active");
    });
  });

  describe("updateQuestTool", () => {
    it("returns state.patch proposal", async () => {
      const result = await updateQuestTool(
        makeToolCtx({
          questId: "quest-123",
          title: "Updated Title",
        }, "en-US", stateWithQuest()),
      );

      expect(result.proposals).toHaveLength(1);
      expect(result.proposals![0].kind).toBe("state.patch");

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("quest-123");
    });

    it("includes updated objectives with generated IDs", async () => {
      const result = await updateQuestTool(
        makeToolCtx({
          questId: "quest-123",
          objectives: [
            { description: "New obj 1" },
            { id: "existing-id", description: "Existing obj" },
          ],
        }, "en-US", stateWithQuest()),
      );

      const patch = result.proposals![0].payload as Record<string, unknown>;
      const questsPatchData = patch.patch as Record<string, unknown>;
      const quests = questsPatchData.quests as Array<Record<string, unknown>>;
      const updated = quests.find((q) => q.id === "quest-123") as Record<string, unknown>;
      const objectives = updated.objectives as Array<Record<string, unknown>>;

      expect(objectives).toHaveLength(2);
      expect(objectives[0].id).toBeDefined();
      expect(objectives[1].id).toBe("existing-id");
    });
  });

  describe("completeObjectiveTool", () => {
    it("emits state.patch and event.emit", async () => {
      const result = await completeObjectiveTool(
        makeToolCtx({
          questId: "quest-123",
          objectiveId: "obj-456",
        }, "en-US", stateWithQuest()),
      );

      expect(result.proposals).toHaveLength(2);
      const kinds = result.proposals!.map((p) => p.kind);
      expect(kinds).toContain("state.patch");
      expect(kinds).toContain("event.emit");

      const event = result.proposals!.find((p) => p.kind === "event.emit");
      const payload = event?.payload as Record<string, unknown>;
      expect(payload.type).toBe("objective_completed");
      expect(payload.questId).toBe("quest-123");
      expect(payload.objectiveId).toBe("obj-456");
    });
  });

  describe("completeQuestTool", () => {
    it("emits state.patch and event.emit with quest_completed", async () => {
      const result = await completeQuestTool(
        makeToolCtx({ questId: "quest-123" }, "en-US", stateWithQuest()),
      );

      expect(result.proposals).toHaveLength(2);
      const event = result.proposals!.find((p) => p.kind === "event.emit");
      expect((event?.payload as Record<string, unknown>).type).toBe(
        "quest_completed",
      );
    });
  });

  describe("failQuestTool", () => {
    it("emits state.patch and event.emit with quest_failed", async () => {
      const result = await failQuestTool(
        makeToolCtx({ questId: "quest-123" }, "en-US", stateWithQuest()),
      );

      expect(result.proposals).toHaveLength(2);
      const event = result.proposals!.find((p) => p.kind === "event.emit");
      expect((event?.payload as Record<string, unknown>).type).toBe(
        "quest_failed",
      );

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("failed");
    });

    it("returns zh-CN message for Chinese locale", async () => {
      const result = await failQuestTool(
        makeToolCtx({ questId: "quest-123" }, "zh-CN", stateWithQuest()),
      );

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("已失败");
    });
  });
});

// ── Context provider tests ──────────────────────────────────

describe("questContextProvider", () => {
  it("returns null for no quests", async () => {
    const result = await questContextProvider({
      pluginId: "core-quest",
      runtimeId: "quest-tracker",
      locale: "en-US",
      state: {},
    });

    expect(result).toBeNull();
  });

  it("returns quest summary for active quests", async () => {
    resetIds();
    const { state } = createQuest(
      EMPTY_STATE,
      {
        title: "Find Gem",
        description: "Locate the gem",
        type: "main",
        objectives: [{ description: "Enter cave" }],
      },
      "turn-1",
      deterministicId,
    );

    const result = (await questContextProvider({
      pluginId: "core-quest",
      runtimeId: "quest-tracker",
      locale: "en-US",
      state: { "core-quest": state },
    })) as Record<string, unknown>;

    expect((result.content as string)).toContain("Find Gem");
    expect(result.priority).toBe(70);
  });

  it("returns null for Chinese locale with no quests", async () => {
    const result = await questContextProvider({
      pluginId: "core-quest",
      runtimeId: "quest-tracker",
      locale: "zh-CN",
      state: {},
    });

    expect(result).toBeNull();
  });
});
