/**
 * Pure business logic for quest management.
 * All functions are immutable — they return new state objects.
 */

export interface QuestObjective {
  readonly id: string;
  readonly description: string;
  readonly completed: boolean;
  readonly optional?: boolean;
}

export interface Quest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly type: "main" | "side" | "hidden";
  readonly status: "discovered" | "active" | "completed" | "failed" | "abandoned";
  readonly objectives: readonly QuestObjective[];
  readonly rewards?: string;
  readonly giverNpcId?: string;
  readonly discoveredTurnId: string;
  readonly completedTurnId?: string;
}

export interface QuestState {
  readonly quests: readonly Quest[];
  readonly activeQuestId?: string;
}

export const EMPTY_STATE: QuestState = {
  quests: [],
  activeQuestId: undefined,
};

export interface CreateQuestInput {
  readonly title: string;
  readonly description: string;
  readonly type: "main" | "side" | "hidden";
  readonly objectives: ReadonlyArray<{
    readonly description: string;
    readonly optional?: boolean;
  }>;
  readonly rewards?: string;
  readonly giverNpcId?: string;
}

export interface CreateQuestResult {
  readonly state: QuestState;
  readonly quest: Quest;
}

/**
 * Create a new quest with generated IDs.
 * Status defaults to "active". Sets activeQuestId if no quest is currently active.
 */
export function createQuest(
  state: QuestState,
  input: CreateQuestInput,
  turnId: string,
  generateId: () => string = () => crypto.randomUUID(),
): CreateQuestResult {
  const questId = generateId();

  const objectives: QuestObjective[] = input.objectives.map((obj) => ({
    id: generateId(),
    description: obj.description,
    completed: false,
    optional: obj.optional,
  }));

  const quest: Quest = {
    id: questId,
    title: input.title,
    description: input.description,
    type: input.type,
    status: "active",
    objectives,
    rewards: input.rewards,
    giverNpcId: input.giverNpcId,
    discoveredTurnId: turnId,
  };

  const newState: QuestState = {
    quests: [...state.quests, quest],
    activeQuestId: state.activeQuestId ?? questId,
  };

  return { state: newState, quest };
}

/**
 * Update a quest's mutable fields (title, description, objectives, rewards).
 * Throws if quest not found.
 */
export function updateQuest(
  state: QuestState,
  questId: string,
  updates: Partial<Pick<Quest, "title" | "description" | "rewards">> & {
    readonly objectives?: ReadonlyArray<{
      readonly id?: string;
      readonly description: string;
      readonly completed?: boolean;
      readonly optional?: boolean;
    }>;
  },
  generateId: () => string = () => crypto.randomUUID(),
): QuestState {
  const questIndex = state.quests.findIndex((q) => q.id === questId);
  if (questIndex === -1) {
    throw new Error(`Quest not found: ${questId}`);
  }

  const existing = state.quests[questIndex];

  const updatedObjectives = updates.objectives
    ? updates.objectives.map((obj) => ({
        id: obj.id ?? generateId(),
        description: obj.description,
        completed: obj.completed ?? false,
        optional: obj.optional,
      }))
    : existing.objectives;

  const updatedQuest: Quest = {
    ...existing,
    title: updates.title ?? existing.title,
    description: updates.description ?? existing.description,
    rewards: updates.rewards ?? existing.rewards,
    objectives: updatedObjectives,
  };

  const newQuests = state.quests.map((q, i) =>
    i === questIndex ? updatedQuest : q,
  );

  return { ...state, quests: newQuests };
}

/**
 * Mark a specific objective as completed.
 * Throws if quest or objective not found.
 */
export function completeObjective(
  state: QuestState,
  questId: string,
  objectiveId: string,
): QuestState {
  const questIndex = state.quests.findIndex((q) => q.id === questId);
  if (questIndex === -1) {
    throw new Error(`Quest not found: ${questId}`);
  }

  const quest = state.quests[questIndex];
  const objIndex = quest.objectives.findIndex((o) => o.id === objectiveId);
  if (objIndex === -1) {
    throw new Error(`Objective not found: ${objectiveId} in quest ${questId}`);
  }

  const updatedObjectives = quest.objectives.map((o, i) =>
    i === objIndex ? { ...o, completed: true } : o,
  );

  const updatedQuest: Quest = {
    ...quest,
    objectives: updatedObjectives,
  };

  const newQuests = state.quests.map((q, i) =>
    i === questIndex ? updatedQuest : q,
  );

  return { ...state, quests: newQuests };
}

/**
 * Mark a quest as completed.
 * Throws if quest not found. Sets completedTurnId.
 * If the completed quest was the active quest, clears activeQuestId.
 */
export function completeQuest(
  state: QuestState,
  questId: string,
  turnId: string,
): QuestState {
  const questIndex = state.quests.findIndex((q) => q.id === questId);
  if (questIndex === -1) {
    throw new Error(`Quest not found: ${questId}`);
  }

  const updatedQuest: Quest = {
    ...state.quests[questIndex],
    status: "completed",
    completedTurnId: turnId,
  };

  const newQuests = state.quests.map((q, i) =>
    i === questIndex ? updatedQuest : q,
  );

  const activeQuestId =
    state.activeQuestId === questId ? undefined : state.activeQuestId;

  return { quests: newQuests, activeQuestId };
}

/**
 * Mark a quest as failed.
 * Throws if quest not found.
 * If the failed quest was the active quest, clears activeQuestId.
 */
export function failQuest(state: QuestState, questId: string): QuestState {
  const questIndex = state.quests.findIndex((q) => q.id === questId);
  if (questIndex === -1) {
    throw new Error(`Quest not found: ${questId}`);
  }

  const updatedQuest: Quest = {
    ...state.quests[questIndex],
    status: "failed",
  };

  const newQuests = state.quests.map((q, i) =>
    i === questIndex ? updatedQuest : q,
  );

  const activeQuestId =
    state.activeQuestId === questId ? undefined : state.activeQuestId;

  return { quests: newQuests, activeQuestId };
}

/**
 * Get all quests with status "active" or "discovered".
 */
export function getActiveQuests(state: QuestState): readonly Quest[] {
  return state.quests.filter(
    (q) => q.status === "active" || q.status === "discovered",
  );
}

/**
 * Build a human-readable quest summary for context injection.
 */
export function getQuestSummary(state: QuestState, locale: string): string {
  const isZh = locale.startsWith("zh");
  const active = getActiveQuests(state);

  if (active.length === 0) {
    return isZh ? "当前没有进行中的任务。" : "No active quests.";
  }

  const lines: string[] = [];
  for (const quest of active) {
    const typeLabel = isZh
      ? { main: "主线", side: "支线", hidden: "隐藏" }[quest.type]
      : { main: "Main", side: "Side", hidden: "Hidden" }[quest.type];

    const statusLabel = isZh
      ? { discovered: "已发现", active: "进行中", completed: "已完成", failed: "已失败", abandoned: "已放弃" }[quest.status]
      : quest.status;

    lines.push(
      `[${typeLabel}][${statusLabel}] ${quest.title}: ${quest.description}`,
    );

    for (const obj of quest.objectives) {
      const check = obj.completed ? "[x]" : "[ ]";
      const optionalTag = obj.optional ? (isZh ? " (可选)" : " (optional)") : "";
      lines.push(`  ${check} ${obj.description}${optionalTag}`);
    }
  }

  return lines.join("\n");
}
