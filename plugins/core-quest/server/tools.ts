import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import { z } from "zod";
import {
  createQuest,
  updateQuest,
  completeObjective,
  completeQuest,
  failQuest,
  EMPTY_STATE,
  type QuestState,
} from "./quest-logic.js";

// ── Zod Schemas ─────────────────────────────────────────────────

const createQuestInputSchema = z.object({
  title: z.string(),
  description: z.string(),
  type: z.enum(["main", "side", "hidden"]),
  objectives: z.array(z.object({
    description: z.string(),
    optional: z.boolean().optional(),
  })),
  rewards: z.string().optional(),
  giverNpcId: z.string().optional(),
});

const updateQuestInputSchema = z.object({
  questId: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  objectives: z.array(z.object({
    id: z.string().optional(),
    description: z.string(),
    completed: z.boolean().optional(),
    optional: z.boolean().optional(),
  })).optional(),
  rewards: z.string().optional(),
});

const completeObjectiveInputSchema = z.object({
  questId: z.string(),
  objectiveId: z.string(),
});

const questIdInputSchema = z.object({
  questId: z.string(),
});

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
  const parsed = createQuestInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  const currentState = extractQuestState(ctx.state);
  // TODO(MEDIUM-1): ctx.runtimeId is used as turnId — semantic mismatch.
  // Proper fix requires kernel to provide turnId in the tool context.
  const turnId = ctx.runtimeId;

  try {
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
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
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
  const parsed = updateQuestInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  const currentState = extractQuestState(ctx.state);

  try {
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
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
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
  const parsed = completeObjectiveInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  const currentState = extractQuestState(ctx.state);

  try {
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
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
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
  const parsed = questIdInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  const currentState = extractQuestState(ctx.state);
  // TODO(MEDIUM-1): ctx.runtimeId is used as turnId — semantic mismatch.
  // Proper fix requires kernel to provide turnId in the tool context.
  const turnId = ctx.runtimeId;

  try {
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
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
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
  const parsed = questIdInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const input = parsed.data;

  const currentState = extractQuestState(ctx.state);

  try {
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
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { output: { error: msg } };
  }
}
