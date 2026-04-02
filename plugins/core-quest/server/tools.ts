import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import {
  createQuest,
  updateQuest,
  completeObjective,
  completeQuest,
  failQuest,
  EMPTY_STATE,
  type QuestState,
} from "./quest-logic.js";

// ── Helpers ───────────────────────────────────────────────────────

function extractQuestState(state: Record<string, unknown> | undefined): QuestState {
  if (state && typeof state === "object" && Array.isArray(state.quests)) {
    return state as unknown as QuestState;
  }
  return EMPTY_STATE;
}

/**
 * Tool: create-quest
 *
 * Creates a new quest. The LLM provides all quest data;
 * the tool generates an ID and emits proposals.
 */
export async function createQuestTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const input = ctx.input as {
    title: string;
    description: string;
    type: "main" | "side" | "hidden";
    objectives: Array<{ description: string; optional?: boolean }>;
    rewards?: string;
    giverNpcId?: string;
  };

  const currentState = extractQuestState(ctx.state);
  const turnId = ctx.runtimeId;

  const result = createQuest(currentState, {
    title: input.title,
    description: input.description,
    type: input.type,
    objectives: input.objectives,
    rewards: input.rewards,
    giverNpcId: input.giverNpcId,
  }, turnId);

  return {
    output: {
      message: isZh
        ? `已创建任务「${result.quest.title}」(${result.quest.id})，包含 ${result.quest.objectives.length} 个目标。`
        : `Created quest "${result.quest.title}" (${result.quest.id}) with ${result.quest.objectives.length} objectives.`,
      questId: result.quest.id,
      objectiveIds: result.quest.objectives.map((o) => o.id),
    },
    proposals: [
      {
        kind: "state.patch",
        payload: {
          scope: "core-quest",
          patch: { quests: result.state.quests, activeQuestId: result.state.activeQuestId },
        },
      },
      {
        kind: "record.upsert",
        payload: {
          key: `quest:${result.quest.id}`,
          recordType: "quest",
          value: result.quest,
        },
      },
      {
        kind: "event.emit",
        payload: {
          type: "quest_discovered",
          questId: result.quest.id,
          questTitle: result.quest.title,
          questType: result.quest.type,
        },
      },
    ],
  };
}

/**
 * Tool: update-quest
 *
 * Updates quest details. The LLM provides the questId and fields to update.
 */
export async function updateQuestTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const input = ctx.input as {
    questId: string;
    title?: string;
    description?: string;
    objectives?: Array<{
      id?: string;
      description: string;
      completed?: boolean;
      optional?: boolean;
    }>;
    rewards?: string;
  };

  const currentState = extractQuestState(ctx.state);

  const updates: Parameters<typeof updateQuest>[2] = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.rewards !== undefined) updates.rewards = input.rewards;
  if (input.objectives !== undefined) updates.objectives = input.objectives;

  const newState = updateQuest(currentState, input.questId, updates);

  return {
    output: {
      message: isZh
        ? `已更新任务 ${input.questId}。`
        : `Updated quest ${input.questId}.`,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: {
          scope: "core-quest",
          patch: { quests: newState.quests },
        },
      },
    ],
  };
}

/**
 * Tool: complete-objective
 *
 * Marks a specific objective as completed.
 */
export async function completeObjectiveTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const input = ctx.input as {
    questId: string;
    objectiveId: string;
  };

  const currentState = extractQuestState(ctx.state);
  const newState = completeObjective(currentState, input.questId, input.objectiveId);

  return {
    output: {
      message: isZh
        ? `已完成目标 ${input.objectiveId}（任务：${input.questId}）。`
        : `Completed objective ${input.objectiveId} (quest: ${input.questId}).`,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: {
          scope: "core-quest",
          patch: { quests: newState.quests },
        },
      },
      {
        kind: "event.emit",
        payload: {
          type: "objective_completed",
          questId: input.questId,
          objectiveId: input.objectiveId,
        },
      },
    ],
  };
}

/**
 * Tool: complete-quest
 *
 * Marks a quest as completed.
 */
export async function completeQuestTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const input = ctx.input as {
    questId: string;
  };

  const currentState = extractQuestState(ctx.state);
  const turnId = ctx.runtimeId;
  const newState = completeQuest(currentState, input.questId, turnId);

  return {
    output: {
      message: isZh
        ? `任务 ${input.questId} 已完成！`
        : `Quest ${input.questId} completed!`,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: {
          scope: "core-quest",
          patch: { quests: newState.quests, activeQuestId: newState.activeQuestId },
        },
      },
      {
        kind: "event.emit",
        payload: {
          type: "quest_completed",
          questId: input.questId,
        },
      },
    ],
  };
}

/**
 * Tool: fail-quest
 *
 * Marks a quest as failed.
 */
export async function failQuestTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const input = ctx.input as {
    questId: string;
  };

  const currentState = extractQuestState(ctx.state);
  const newState = failQuest(currentState, input.questId);

  return {
    output: {
      message: isZh
        ? `任务 ${input.questId} 已失败。`
        : `Quest ${input.questId} failed.`,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: {
          scope: "core-quest",
          patch: { quests: newState.quests, activeQuestId: newState.activeQuestId },
        },
      },
      {
        kind: "event.emit",
        payload: {
          type: "quest_failed",
          questId: input.questId,
        },
      },
    ],
  };
}
