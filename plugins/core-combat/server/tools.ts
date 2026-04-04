import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import { z } from "zod";
import {
  initCombat,
  resolveAttack,
  applyDefense,
  resolveSkill,
  advanceTurn,
  updateParticipant,
  appendLog,
  isCombatOver,
  getCombatSummary,
  tickStatusDurations,
  buildCombatStatusBlock,
} from "./combat-logic.js";
import type {
  CombatState,
  CombatParticipant,
  ParticipantInput,
} from "./combat-logic.js";

// ── Zod Schemas ───────────────────────────────────────────────────

const participantSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["player", "ally", "enemy"]),
  hp: z.number(),
  maxHp: z.number(),
  statusEffects: z.array(z.object({
    id: z.string(),
    name: z.string(),
    duration: z.number(),
    effect: z.record(z.string(), z.unknown()),
  })).optional(),
});

const startCombatInputSchema = z.object({
  participants: z.array(participantSchema).min(1),
  initiativeRolls: z.array(z.number()).optional(),
});

const attackInputSchema = z.object({
  attackerId: z.string(),
  targetId: z.string(),
  rollResult: z.number(),
});

const defendInputSchema = z.object({
  participantId: z.string(),
});

const useSkillInputSchema = z.object({
  actorId: z.string(),
  targetId: z.string(),
  skillName: z.string(),
  skillType: z.enum(["damage", "heal", "buff", "debuff"]),
  rollResult: z.number(),
  magnitude: z.number().optional(),
});

const endCombatInputSchema = z.object({
  reason: z.enum(["victory", "defeat", "retreat", "narrative"]),
});

// ── Helpers ────────────────────────────────────────────────────────

function combatStatusProposal(combat: CombatState) {
  return {
    kind: "ui.render" as const,
    payload: {
      type: "combat_status",
      content: buildCombatStatusBlock(combat),
    },
  };
}

// ── start-combat ───────────────────────────────────────────────────

interface StartCombatInput {
  participants: ParticipantInput[];
  initiativeRolls?: number[];
}

export async function startCombatTool(
  ctx: ToolExecutionContext<StartCombatInput>
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = startCombatInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const { participants } = parsed.data;

  // Use provided initiative rolls or default to indices (in real usage, LLM calls core-dice first)
  const initiativeRolls =
    parsed.data.initiativeRolls ??
    participants.map((_, i) => (participants.length - i) * 5);

  const turnId =
    typeof ctx.runtimeId === "string" ? ctx.runtimeId : "unknown_turn";
  const combat = initCombat(participants, initiativeRolls, turnId);

  const summary = getCombatSummary(combat, ctx.locale);

  return {
    output: {
      message: isZh
        ? `战斗开始！${participants.length} 名参与者就绪。`
        : `Combat started! ${participants.length} participants ready.`,
      summary,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: { combat },
      },
      {
        kind: "record.upsert",
        payload: {
          key: "combat:active",
          recordType: "combat_state",
          value: combat,
        },
      },
      {
        kind: "event.emit",
        payload: { type: "combat_started", data: { participantCount: participants.length } },
      },
      combatStatusProposal(combat),
    ],
  };
}

// ── attack ─────────────────────────────────────────────────────────

interface AttackInput {
  attackerId: string;
  targetId: string;
  rollResult: number;
}

export async function attackTool(
  ctx: ToolExecutionContext<AttackInput>
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = attackInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }

  // Retrieve combat from the broader state context
  const combatState = extractCombatFromContext(ctx);

  if (!combatState || !combatState.active) {
    return {
      output: {
        error: isZh ? "当前没有进行中的战斗" : "No active combat",
      },
    };
  }

  const { attackerId, targetId, rollResult } = parsed.data;

  const attacker = combatState.turnOrder.find((p) => p.id === attackerId);
  const target = combatState.turnOrder.find((p) => p.id === targetId);

  if (!attacker || !target) {
    return {
      output: {
        error: isZh ? "找不到攻击者或目标" : "Attacker or target not found",
      },
    };
  }

  if (attacker.isDefeated) {
    return {
      output: {
        error: isZh ? "攻击者已被击败" : "Attacker is already defeated",
      },
    };
  }

  if (target.isDefeated) {
    return {
      output: {
        error: isZh ? "目标已被击败" : "Target is already defeated",
      },
    };
  }

  const result = resolveAttack(attacker, target, rollResult);

  let updated = updateParticipant(combatState, targetId, {
    hp: result.newTargetHp,
    isDefeated: result.defeated,
  });

  updated = appendLog(updated, {
    round: updated.roundNumber,
    actorId: attackerId,
    action: "attack",
    targetId,
    result: result.defeated
      ? isZh
        ? `${target.name} 被击败！`
        : `${target.name} was defeated!`
      : isZh
        ? `命中！造成 ${result.damage} 点伤害。`
        : `Hit! Dealt ${result.damage} damage.`,
    damage: result.damage,
  });

  updated = advanceTurn(updated);

  // Tick durations if we wrapped around to a new round
  if (updated.roundNumber > combatState.roundNumber) {
    updated = tickStatusDurations(updated);
  }

  const combatOver = isCombatOver(updated);

  return {
    output: {
      damage: result.damage,
      defeated: result.defeated,
      newTargetHp: result.newTargetHp,
      combatOver: combatOver.over,
      winner: combatOver.winner,
      message: isZh
        ? `${attacker.name} 攻击 ${target.name}，造成 ${result.damage} 点伤害。${result.defeated ? `${target.name} 被击败！` : `${target.name} 剩余 ${result.newTargetHp} HP。`}`
        : `${attacker.name} attacks ${target.name} for ${result.damage} damage. ${result.defeated ? `${target.name} is defeated!` : `${target.name} has ${result.newTargetHp} HP remaining.`}`,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: { combat: updated },
      },
      {
        kind: "event.emit",
        payload: {
          type: "combat_action",
          data: {
            action: "attack",
            actorId: attackerId,
            targetId,
            damage: result.damage,
            defeated: result.defeated,
          },
        },
      },
      combatStatusProposal(updated),
    ],
  };
}

// ── defend ─────────────────────────────────────────────────────────

interface DefendInput {
  participantId: string;
}

export async function defendTool(
  ctx: ToolExecutionContext<DefendInput>
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = defendInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }

  const combatState = extractCombatFromContext(ctx);

  if (!combatState || !combatState.active) {
    return {
      output: {
        error: isZh ? "当前没有进行中的战斗" : "No active combat",
      },
    };
  }

  const { participantId } = parsed.data;
  const participant = combatState.turnOrder.find(
    (p) => p.id === participantId
  );

  if (!participant) {
    return {
      output: {
        error: isZh ? "找不到参与者" : "Participant not found",
      },
    };
  }

  if (participant.isDefeated) {
    return {
      output: {
        error: isZh ? "该参与者已被击败" : "Participant is already defeated",
      },
    };
  }

  const defended = applyDefense(participant);

  let updated = updateParticipant(combatState, participantId, {
    statusEffects: defended.statusEffects,
  });

  updated = appendLog(updated, {
    round: updated.roundNumber,
    actorId: participantId,
    action: "defend",
    result: isZh
      ? `${participant.name} 采取防御姿态。`
      : `${participant.name} takes a defensive stance.`,
  });

  updated = advanceTurn(updated);

  if (updated.roundNumber > combatState.roundNumber) {
    updated = tickStatusDurations(updated);
  }

  return {
    output: {
      message: isZh
        ? `${participant.name} 进入防御状态，本回合受到的伤害减半。`
        : `${participant.name} is defending. Damage taken this round is halved.`,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: { combat: updated },
      },
    ],
  };
}

// ── use-skill ──────────────────────────────────────────────────────

interface UseSkillInput {
  actorId: string;
  targetId: string;
  skillName: string;
  skillType: "damage" | "heal" | "buff" | "debuff";
  rollResult: number;
  magnitude?: number;
}

export async function useSkillTool(
  ctx: ToolExecutionContext<UseSkillInput>
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = useSkillInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }

  const combatState = extractCombatFromContext(ctx);

  if (!combatState || !combatState.active) {
    return {
      output: {
        error: isZh ? "当前没有进行中的战斗" : "No active combat",
      },
    };
  }

  const { actorId, targetId, skillName, skillType, rollResult, magnitude } =
    parsed.data;

  const actor = combatState.turnOrder.find((p) => p.id === actorId);
  const target = combatState.turnOrder.find((p) => p.id === targetId);

  if (!actor || !target) {
    return {
      output: {
        error: isZh ? "找不到行动者或目标" : "Actor or target not found",
      },
    };
  }

  if (actor.isDefeated) {
    return {
      output: {
        error: isZh ? "行动者已被击败" : "Actor is already defeated",
      },
    };
  }

  const result = resolveSkill(actor, target, skillType, rollResult, magnitude);

  let updated = combatState;

  // Apply HP changes
  if (skillType === "damage" || skillType === "heal") {
    updated = updateParticipant(updated, targetId, {
      hp: result.newTargetHp,
      isDefeated: result.defeated,
    });
  }

  // Apply status effect
  if (result.appliedEffect) {
    const currentTarget = updated.turnOrder.find((p) => p.id === targetId);
    if (currentTarget) {
      updated = updateParticipant(updated, targetId, {
        statusEffects: [...currentTarget.statusEffects, result.appliedEffect],
      });
    }
  }

  const resultMessage = buildSkillResultMessage(
    actor,
    target,
    skillName,
    skillType,
    result.effectValue,
    result.defeated,
    isZh
  );

  updated = appendLog(updated, {
    round: updated.roundNumber,
    actorId,
    action: `skill:${skillName}`,
    targetId,
    result: resultMessage,
    damage: skillType === "damage" ? result.effectValue : undefined,
  });

  updated = advanceTurn(updated);

  if (updated.roundNumber > combatState.roundNumber) {
    updated = tickStatusDurations(updated);
  }

  const combatOver = isCombatOver(updated);

  return {
    output: {
      effectValue: result.effectValue,
      defeated: result.defeated,
      newTargetHp: result.newTargetHp,
      combatOver: combatOver.over,
      winner: combatOver.winner,
      message: resultMessage,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: { combat: updated },
      },
      {
        kind: "event.emit",
        payload: {
          type: "combat_action",
          data: {
            action: `skill:${skillName}`,
            actorId,
            targetId,
            skillType,
            effectValue: result.effectValue,
            defeated: result.defeated,
          },
        },
      },
      combatStatusProposal(updated),
    ],
  };
}

// ── end-combat ─────────────────────────────────────────────────────

interface EndCombatInput {
  reason: "victory" | "defeat" | "retreat" | "narrative";
}

export async function endCombatTool(
  ctx: ToolExecutionContext<EndCombatInput>
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = endCombatInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }

  const combatState = extractCombatFromContext(ctx);

  if (!combatState) {
    return {
      output: {
        error: isZh ? "当前没有进行中的战斗" : "No active combat",
      },
    };
  }

  const { reason } = parsed.data;

  const clearedCombat: CombatState = {
    ...combatState,
    active: false,
  };

  const summary = getCombatSummary(combatState, ctx.locale);
  const outcomeText = buildEndCombatNarrative(reason, combatState, isZh);

  return {
    output: {
      message: isZh ? "战斗结束。" : "Combat ended.",
      reason,
      summary,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: { combat: clearedCombat },
      },
      {
        kind: "record.upsert",
        payload: {
          key: "combat:active",
          recordType: "combat_state",
          value: clearedCombat,
        },
      },
      {
        kind: "event.emit",
        payload: {
          type: "combat_ended",
          data: {
            reason,
            rounds: combatState.roundNumber,
            log: combatState.log,
          },
        },
      },
      {
        kind: "narrative.append",
        payload: { text: outcomeText },
      },
    ],
  };
}

// ── Internal Helpers ───────────────────────────────────────────────

/**
 * Extract CombatState from the tool execution context.
 * The state is typically available via ctx (injected by the kernel).
 */
function extractCombatFromContext(
  ctx: ToolExecutionContext
): CombatState | null {
  const stateObj = ctx.state;
  if (!stateObj || typeof stateObj !== "object") {
    return null;
  }

  const combat = stateObj.combat;
  if (!combat || typeof combat !== "object") {
    return null;
  }

  // Validate required CombatState fields before casting
  const c = combat as Record<string, unknown>;
  if (
    typeof c.active !== "boolean" ||
    !Array.isArray(c.turnOrder) ||
    typeof c.roundNumber !== "number"
  ) {
    return null;
  }

  return combat as CombatState;
}

function buildSkillResultMessage(
  actor: CombatParticipant,
  target: CombatParticipant,
  skillName: string,
  skillType: string,
  effectValue: number,
  defeated: boolean,
  isZh: boolean
): string {
  if (isZh) {
    switch (skillType) {
      case "damage":
        return defeated
          ? `${actor.name} 使用「${skillName}」对 ${target.name} 造成 ${effectValue} 点伤害，${target.name} 被击败！`
          : `${actor.name} 使用「${skillName}」对 ${target.name} 造成 ${effectValue} 点伤害。`;
      case "heal":
        return `${actor.name} 使用「${skillName}」为 ${target.name} 恢复了 ${effectValue} 点生命值。`;
      case "buff":
        return `${actor.name} 使用「${skillName}」强化了 ${target.name}。`;
      case "debuff":
        return `${actor.name} 使用「${skillName}」削弱了 ${target.name}。`;
      default:
        return `${actor.name} 使用了「${skillName}」。`;
    }
  }

  switch (skillType) {
    case "damage":
      return defeated
        ? `${actor.name} uses ${skillName} on ${target.name} for ${effectValue} damage. ${target.name} is defeated!`
        : `${actor.name} uses ${skillName} on ${target.name} for ${effectValue} damage.`;
    case "heal":
      return `${actor.name} uses ${skillName} to heal ${target.name} for ${effectValue} HP.`;
    case "buff":
      return `${actor.name} uses ${skillName} to empower ${target.name}.`;
    case "debuff":
      return `${actor.name} uses ${skillName} to weaken ${target.name}.`;
    default:
      return `${actor.name} uses ${skillName}.`;
  }
}

function buildEndCombatNarrative(
  reason: string,
  state: CombatState,
  isZh: boolean
): string {
  const rounds = state.roundNumber;

  if (isZh) {
    switch (reason) {
      case "victory":
        return `经过 ${rounds} 回合的激战，敌人全部被击败。战场归于平静。`;
      case "defeat":
        return `经过 ${rounds} 回合的苦战，你倒在了战场上...`;
      case "retreat":
        return `你在第 ${rounds} 回合选择了撤退，退出了战场。`;
      case "narrative":
        return `战斗在第 ${rounds} 回合被突如其来的事件打断。`;
      default:
        return `战斗在第 ${rounds} 回合结束。`;
    }
  }

  switch (reason) {
    case "victory":
      return `After ${rounds} rounds of fierce battle, all enemies have been defeated. The battlefield falls silent.`;
    case "defeat":
      return `After ${rounds} rounds of desperate fighting, you fall on the battlefield...`;
    case "retreat":
      return `You chose to retreat on round ${rounds}, withdrawing from the battlefield.`;
    case "narrative":
      return `The battle was interrupted by an unexpected turn of events on round ${rounds}.`;
    default:
      return `The battle ended on round ${rounds}.`;
  }
}
