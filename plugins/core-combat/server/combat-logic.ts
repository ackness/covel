/**
 * Pure combat mechanics — all functions are deterministic and side-effect-free.
 * Randomness comes exclusively from core-dice roll results passed as arguments.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface CombatParticipant {
  readonly id: string;
  readonly name: string;
  readonly type: "player" | "ally" | "enemy";
  readonly hp: number;
  readonly maxHp: number;
  readonly initiative: number;
  readonly statusEffects: readonly StatusEffect[];
  readonly isDefeated: boolean;
}

export interface StatusEffect {
  readonly id: string;
  readonly name: string;
  readonly duration: number; // rounds remaining
  readonly effect: Readonly<Record<string, unknown>>;
}

export interface CombatLogEntry {
  readonly round: number;
  readonly actorId: string;
  readonly action: string;
  readonly targetId?: string;
  readonly result: string;
  readonly damage?: number;
}

export interface CombatState {
  readonly active: boolean;
  readonly roundNumber: number;
  readonly turnOrder: readonly CombatParticipant[];
  readonly currentTurnIndex: number;
  readonly log: readonly CombatLogEntry[];
  readonly startedTurnId: string;
}

export interface AttackResult {
  readonly damage: number;
  readonly newTargetHp: number;
  readonly defeated: boolean;
}

export interface SkillResult {
  readonly effectValue: number;
  readonly newTargetHp: number;
  readonly defeated: boolean;
  readonly appliedEffect?: StatusEffect;
}

export interface CombatOverResult {
  readonly over: boolean;
  readonly winner: "player" | "enemy" | "draw" | null;
}

// ── Participant input (without initiative/isDefeated) ──────────────

export type ParticipantInput = Omit<
  CombatParticipant,
  "initiative" | "isDefeated" | "statusEffects"
> & {
  readonly statusEffects?: readonly StatusEffect[];
};

// ── Constants ──────────────────────────────────────────────────────

const BASE_DAMAGE = 5;
const DAMAGE_MULTIPLIER = 0.5;
const DEFENSE_BONUS_ID = "defending";
const DEFENSE_DAMAGE_REDUCTION = 0.5;
const DEFENSE_DURATION = 1;
const SKILL_BASE_MULTIPLIER = 0.6;
const HEAL_BASE = 8;
const HEAL_MULTIPLIER = 0.4;
const BUFF_DURATION = 3;
const DEBUFF_DURATION = 2;

// ── Core Functions ─────────────────────────────────────────────────

/**
 * Initialize a new combat encounter.
 * Initiative values come from dice rolls (one per participant).
 */
export function initCombat(
  participants: readonly ParticipantInput[],
  initiativeRolls: readonly number[],
  turnId: string
): CombatState {
  const withInitiative: CombatParticipant[] = participants.map((p, i) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    hp: p.hp,
    maxHp: p.maxHp,
    initiative: initiativeRolls[i] ?? 0,
    statusEffects: p.statusEffects ?? [],
    isDefeated: false,
  }));

  // Sort by initiative descending (higher goes first)
  const sorted = [...withInitiative].sort(
    (a, b) => b.initiative - a.initiative
  );

  return {
    active: true,
    roundNumber: 1,
    turnOrder: sorted,
    currentTurnIndex: 0,
    log: [],
    startedTurnId: turnId,
  };
}

/**
 * Resolve an attack action.
 * Damage = BASE_DAMAGE + (rollResult * DAMAGE_MULTIPLIER), reduced by defense.
 */
export function resolveAttack(
  attacker: CombatParticipant,
  target: CombatParticipant,
  rollResult: number
): AttackResult {
  const rawDamage = Math.floor(BASE_DAMAGE + rollResult * DAMAGE_MULTIPLIER);

  // Check if target is defending
  const isDefending = target.statusEffects.some(
    (e) => e.id === DEFENSE_BONUS_ID
  );
  const damage = isDefending
    ? Math.floor(rawDamage * DEFENSE_DAMAGE_REDUCTION)
    : rawDamage;

  const newTargetHp = Math.max(0, target.hp - damage);
  const defeated = newTargetHp <= 0;

  return { damage, newTargetHp, defeated };
}

/**
 * Apply a defense stance to a participant.
 * Returns a new participant with the "defending" status effect.
 */
export function applyDefense(
  participant: CombatParticipant
): CombatParticipant {
  // Remove any existing defense effect, then add fresh one
  const filteredEffects = participant.statusEffects.filter(
    (e) => e.id !== DEFENSE_BONUS_ID
  );

  const defenseEffect: StatusEffect = {
    id: DEFENSE_BONUS_ID,
    name: "Defending",
    duration: DEFENSE_DURATION,
    effect: { damageReduction: DEFENSE_DAMAGE_REDUCTION },
  };

  return {
    ...participant,
    statusEffects: [...filteredEffects, defenseEffect],
  };
}

/**
 * Resolve a skill action (damage, heal, buff, or debuff).
 */
export function resolveSkill(
  actor: CombatParticipant,
  target: CombatParticipant,
  skillType: "damage" | "heal" | "buff" | "debuff",
  rollResult: number,
  magnitude?: number
): SkillResult {
  const baseMag = magnitude ?? 10;

  switch (skillType) {
    case "damage": {
      const rawDamage = Math.floor(
        baseMag * SKILL_BASE_MULTIPLIER + rollResult * DAMAGE_MULTIPLIER
      );
      const isDefending = target.statusEffects.some(
        (e) => e.id === DEFENSE_BONUS_ID
      );
      const damage = isDefending
        ? Math.floor(rawDamage * DEFENSE_DAMAGE_REDUCTION)
        : rawDamage;
      const newTargetHp = Math.max(0, target.hp - damage);
      return {
        effectValue: damage,
        newTargetHp,
        defeated: newTargetHp <= 0,
      };
    }

    case "heal": {
      const healAmount = Math.floor(
        HEAL_BASE + rollResult * HEAL_MULTIPLIER + baseMag * 0.3
      );
      const newTargetHp = Math.min(target.maxHp, target.hp + healAmount);
      return {
        effectValue: healAmount,
        newTargetHp,
        defeated: false,
      };
    }

    case "buff": {
      const buffEffect: StatusEffect = {
        id: `buff_${Date.now()}`,
        name: "Empowered",
        duration: BUFF_DURATION,
        effect: { attackBonus: Math.floor(rollResult * 0.2) },
      };
      return {
        effectValue: 0,
        newTargetHp: target.hp,
        defeated: false,
        appliedEffect: buffEffect,
      };
    }

    case "debuff": {
      const debuffEffect: StatusEffect = {
        id: `debuff_${Date.now()}`,
        name: "Weakened",
        duration: DEBUFF_DURATION,
        effect: { attackPenalty: Math.floor(rollResult * 0.15) },
      };
      return {
        effectValue: 0,
        newTargetHp: target.hp,
        defeated: false,
        appliedEffect: debuffEffect,
      };
    }
  }
}

/**
 * Advance to the next turn in combat.
 * Wraps around to the beginning and increments round if needed.
 * Skips defeated participants.
 */
export function advanceTurn(state: CombatState): CombatState {
  const aliveCount = state.turnOrder.filter((p) => !p.isDefeated).length;
  if (aliveCount === 0) {
    return state;
  }

  let nextIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;
  const newRound =
    nextIndex <= state.currentTurnIndex
      ? state.roundNumber + 1
      : state.roundNumber;

  // Skip defeated participants
  let attempts = 0;
  while (
    state.turnOrder[nextIndex]?.isDefeated &&
    attempts < state.turnOrder.length
  ) {
    nextIndex = (nextIndex + 1) % state.turnOrder.length;
    attempts++;
  }

  return {
    ...state,
    currentTurnIndex: nextIndex,
    roundNumber: newRound,
  };
}

/**
 * Tick down status effect durations and remove expired ones.
 * Should be called at the end of each round.
 */
export function tickStatusDurations(state: CombatState): CombatState {
  const updatedOrder = state.turnOrder.map((p) => {
    const tickedEffects = p.statusEffects
      .map((e) => ({ ...e, duration: e.duration - 1 }))
      .filter((e) => e.duration > 0);

    return {
      ...p,
      statusEffects: tickedEffects,
    };
  });

  return {
    ...state,
    turnOrder: updatedOrder,
  };
}

/**
 * Update a participant in the turn order immutably.
 */
export function updateParticipant(
  state: CombatState,
  participantId: string,
  update: Partial<Pick<CombatParticipant, "hp" | "isDefeated" | "statusEffects">>
): CombatState {
  const updatedOrder = state.turnOrder.map((p) =>
    p.id === participantId ? { ...p, ...update } : p
  );

  return {
    ...state,
    turnOrder: updatedOrder,
  };
}

/**
 * Append a log entry to the combat state.
 */
export function appendLog(
  state: CombatState,
  entry: CombatLogEntry
): CombatState {
  return {
    ...state,
    log: [...state.log, entry],
  };
}

/**
 * Check if combat is over.
 * Combat ends when all enemies or all player/allies are defeated.
 */
export function isCombatOver(state: CombatState): CombatOverResult {
  const playerSide = state.turnOrder.filter(
    (p) => p.type === "player" || p.type === "ally"
  );
  const enemySide = state.turnOrder.filter((p) => p.type === "enemy");

  const allPlayerDefeated = playerSide.every((p) => p.isDefeated);
  const allEnemyDefeated = enemySide.every((p) => p.isDefeated);

  if (allPlayerDefeated && allEnemyDefeated) {
    return { over: true, winner: "draw" };
  }
  if (allEnemyDefeated) {
    return { over: true, winner: "player" };
  }
  if (allPlayerDefeated) {
    return { over: true, winner: "enemy" };
  }

  return { over: false, winner: null };
}

/**
 * Get a localized combat summary string.
 */
export function getCombatSummary(state: CombatState, locale: string): string {
  const isZh = locale.startsWith("zh");
  const currentActor = state.turnOrder[state.currentTurnIndex];

  const participantLines = state.turnOrder.map((p) => {
    const status = p.isDefeated
      ? isZh
        ? "已败"
        : "DEFEATED"
      : `${p.hp}/${p.maxHp} HP`;
    const effects =
      p.statusEffects.length > 0
        ? ` [${p.statusEffects.map((e) => `${e.name}(${e.duration})`).join(", ")}]`
        : "";
    const marker = p.id === currentActor?.id ? " ◄" : "";
    return `  ${p.name} (${p.type}) — ${status}${effects}${marker}`;
  });

  const header = isZh
    ? `⚔️ 第 ${state.roundNumber} 回合`
    : `⚔️ Round ${state.roundNumber}`;

  const turnInfo = currentActor
    ? isZh
      ? `当前行动: ${currentActor.name}`
      : `Current turn: ${currentActor.name}`
    : "";

  return [header, turnInfo, ...participantLines].filter(Boolean).join("\n");
}

/**
 * Build a combat_status block content from state, suitable for ui.render.
 */
export function buildCombatStatusBlock(state: CombatState): {
  roundNumber: number;
  currentActor: string;
  participants: ReadonlyArray<{
    id: string;
    name: string;
    type: string;
    hp: number;
    maxHp: number;
    initiative: number;
    isDefeated: boolean;
    statusEffects: ReadonlyArray<{ name: string; duration: number }>;
  }>;
} {
  const currentActor = state.turnOrder[state.currentTurnIndex];

  return {
    roundNumber: state.roundNumber,
    currentActor: currentActor?.name ?? "",
    participants: state.turnOrder.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      hp: p.hp,
      maxHp: p.maxHp,
      initiative: p.initiative,
      isDefeated: p.isDefeated,
      statusEffects: p.statusEffects.map((e) => ({
        name: e.name,
        duration: e.duration,
      })),
    })),
  };
}
