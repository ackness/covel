import { describe, it, expect } from "vitest";
import {
  createMockToolContext,
  createMockProviderInput,
  createCollectingRegistrar,
  findProposal,
  findProposals,
  assertProposalContains,
} from "@covel/plugin-test-utils";
import {
  initCombat,
  resolveAttack,
  applyDefense,
  resolveSkill,
  advanceTurn,
  tickStatusDurations,
  updateParticipant,
  appendLog,
  isCombatOver,
  getCombatSummary,
  buildCombatStatusBlock,
} from "../server/combat-logic.js";
import type {
  CombatState,
  CombatParticipant,
  ParticipantInput,
} from "../server/combat-logic.js";
import register from "../server/index.js";

// ── Test Fixtures ──────────────────────────────────────────────────

const PLAYER: ParticipantInput = {
  id: "player_1",
  name: "Hero",
  type: "player",
  hp: 100,
  maxHp: 100,
};

const ENEMY: ParticipantInput = {
  id: "enemy_1",
  name: "Goblin",
  type: "enemy",
  hp: 30,
  maxHp: 30,
};

const ALLY: ParticipantInput = {
  id: "ally_1",
  name: "Companion",
  type: "ally",
  hp: 80,
  maxHp: 80,
};

function createTestCombat(): CombatState {
  return initCombat([PLAYER, ENEMY, ALLY], [15, 10, 12], "turn_001");
}

// ── initCombat ─────────────────────────────────────────────────────

describe("initCombat", () => {
  it("creates active combat with correct participants", () => {
    const state = initCombat([PLAYER, ENEMY], [18, 12], "turn_001");

    expect(state.active).toBe(true);
    expect(state.roundNumber).toBe(1);
    expect(state.turnOrder).toHaveLength(2);
    expect(state.currentTurnIndex).toBe(0);
    expect(state.log).toEqual([]);
    expect(state.startedTurnId).toBe("turn_001");
  });

  it("sorts participants by initiative descending", () => {
    const state = initCombat([PLAYER, ENEMY, ALLY], [5, 20, 10], "turn_001");

    expect(state.turnOrder[0]!.name).toBe("Goblin"); // initiative 20
    expect(state.turnOrder[1]!.name).toBe("Companion"); // initiative 10
    expect(state.turnOrder[2]!.name).toBe("Hero"); // initiative 5
  });

  it("sets initiative values from rolls", () => {
    const state = initCombat([PLAYER, ENEMY], [15, 8], "turn_001");

    const player = state.turnOrder.find((p) => p.id === "player_1")!;
    const enemy = state.turnOrder.find((p) => p.id === "enemy_1")!;

    expect(player.initiative).toBe(15);
    expect(enemy.initiative).toBe(8);
  });

  it("initializes all participants as not defeated", () => {
    const state = initCombat([PLAYER, ENEMY], [10, 10], "turn_001");

    for (const p of state.turnOrder) {
      expect(p.isDefeated).toBe(false);
      expect(p.statusEffects).toEqual([]);
    }
  });

  it("handles single participant", () => {
    const state = initCombat([PLAYER], [10], "turn_001");

    expect(state.turnOrder).toHaveLength(1);
    expect(state.turnOrder[0]!.id).toBe("player_1");
  });

  it("defaults initiative to 0 when roll is missing", () => {
    const state = initCombat([PLAYER, ENEMY], [15], "turn_001");

    const enemy = state.turnOrder.find((p) => p.id === "enemy_1")!;
    expect(enemy.initiative).toBe(0);
  });
});

// ── resolveAttack ──────────────────────────────────────────────────

describe("resolveAttack", () => {
  it("calculates damage from roll result", () => {
    const state = createTestCombat();
    const attacker = state.turnOrder.find((p) => p.id === "player_1")!;
    const target = state.turnOrder.find((p) => p.id === "enemy_1")!;

    const result = resolveAttack(attacker, target, 10);

    // BASE_DAMAGE(5) + 10 * 0.5 = 10
    expect(result.damage).toBe(10);
    expect(result.newTargetHp).toBe(20);
    expect(result.defeated).toBe(false);
  });

  it("defeats target when damage exceeds HP", () => {
    const state = createTestCombat();
    const attacker = state.turnOrder.find((p) => p.id === "player_1")!;
    const target = state.turnOrder.find((p) => p.id === "enemy_1")!;

    // Roll of 60: BASE_DAMAGE(5) + 60 * 0.5 = 35, exceeds 30 HP
    const result = resolveAttack(attacker, target, 60);

    expect(result.damage).toBe(35);
    expect(result.newTargetHp).toBe(0);
    expect(result.defeated).toBe(true);
  });

  it("never reduces HP below 0", () => {
    const state = createTestCombat();
    const attacker = state.turnOrder.find((p) => p.id === "player_1")!;
    const target = state.turnOrder.find((p) => p.id === "enemy_1")!;

    const result = resolveAttack(attacker, target, 200);

    expect(result.newTargetHp).toBe(0);
    expect(result.defeated).toBe(true);
  });

  it("applies defense damage reduction when target is defending", () => {
    const state = createTestCombat();
    const attacker = state.turnOrder.find((p) => p.id === "player_1")!;
    let target = state.turnOrder.find((p) => p.id === "enemy_1")!;

    target = applyDefense(target);

    const result = resolveAttack(attacker, target, 10);

    // Normal damage: 5 + 10*0.5 = 10, with defense: floor(10 * 0.5) = 5
    expect(result.damage).toBe(5);
    expect(result.newTargetHp).toBe(25);
  });

  it("handles zero roll result", () => {
    const state = createTestCombat();
    const attacker = state.turnOrder.find((p) => p.id === "player_1")!;
    const target = state.turnOrder.find((p) => p.id === "enemy_1")!;

    const result = resolveAttack(attacker, target, 0);

    // BASE_DAMAGE(5) + 0 * 0.5 = 5
    expect(result.damage).toBe(5);
    expect(result.newTargetHp).toBe(25);
  });
});

// ── applyDefense ───────────────────────────────────────────────────

describe("applyDefense", () => {
  it("adds defending status effect", () => {
    const state = createTestCombat();
    const participant = state.turnOrder[0]!;

    const defended = applyDefense(participant);

    expect(defended.statusEffects).toHaveLength(1);
    expect(defended.statusEffects[0]!.id).toBe("defending");
    expect(defended.statusEffects[0]!.duration).toBe(1);
  });

  it("does not mutate original participant", () => {
    const state = createTestCombat();
    const participant = state.turnOrder[0]!;

    const defended = applyDefense(participant);

    expect(participant.statusEffects).toHaveLength(0);
    expect(defended.statusEffects).toHaveLength(1);
  });

  it("replaces existing defense effect with fresh one", () => {
    const state = createTestCombat();
    let participant = state.turnOrder[0]!;

    participant = applyDefense(participant);
    participant = applyDefense(participant);

    // Should still only have one defense effect
    const defenseEffects = participant.statusEffects.filter(
      (e) => e.id === "defending"
    );
    expect(defenseEffects).toHaveLength(1);
  });

  it("preserves other status effects", () => {
    const participant: CombatParticipant = {
      id: "test",
      name: "Test",
      type: "player",
      hp: 50,
      maxHp: 50,
      initiative: 10,
      isDefeated: false,
      statusEffects: [
        { id: "poison", name: "Poison", duration: 3, effect: {} },
      ],
    };

    const defended = applyDefense(participant);

    expect(defended.statusEffects).toHaveLength(2);
    expect(defended.statusEffects.some((e) => e.id === "poison")).toBe(true);
    expect(defended.statusEffects.some((e) => e.id === "defending")).toBe(true);
  });
});

// ── resolveSkill ───────────────────────────────────────────────────

describe("resolveSkill", () => {
  const actor: CombatParticipant = {
    id: "actor",
    name: "Mage",
    type: "player",
    hp: 80,
    maxHp: 80,
    initiative: 10,
    isDefeated: false,
    statusEffects: [],
  };

  const target: CombatParticipant = {
    id: "target",
    name: "Orc",
    type: "enemy",
    hp: 50,
    maxHp: 50,
    initiative: 8,
    isDefeated: false,
    statusEffects: [],
  };

  it("resolves damage skill", () => {
    const result = resolveSkill(actor, target, "damage", 10, 15);

    // baseMag(15) * 0.6 + 10 * 0.5 = 9 + 5 = 14
    expect(result.effectValue).toBe(14);
    expect(result.newTargetHp).toBe(36);
    expect(result.defeated).toBe(false);
  });

  it("resolves heal skill", () => {
    const injured: CombatParticipant = { ...target, hp: 20 };
    const result = resolveSkill(actor, injured, "heal", 10, 15);

    // HEAL_BASE(8) + 10 * 0.4 + 15 * 0.3 = 8 + 4 + 4.5 = floor(16.5) = 16
    expect(result.effectValue).toBe(16);
    expect(result.newTargetHp).toBe(36);
    expect(result.defeated).toBe(false);
  });

  it("heal does not exceed maxHp", () => {
    const result = resolveSkill(actor, target, "heal", 10, 15);

    expect(result.newTargetHp).toBe(50); // capped at maxHp
  });

  it("resolves buff skill with applied effect", () => {
    const result = resolveSkill(actor, target, "buff", 10);

    expect(result.effectValue).toBe(0);
    expect(result.newTargetHp).toBe(50);
    expect(result.appliedEffect).toBeDefined();
    expect(result.appliedEffect!.name).toBe("Empowered");
    expect(result.appliedEffect!.duration).toBe(3);
  });

  it("resolves debuff skill with applied effect", () => {
    const result = resolveSkill(actor, target, "debuff", 10);

    expect(result.effectValue).toBe(0);
    expect(result.appliedEffect).toBeDefined();
    expect(result.appliedEffect!.name).toBe("Weakened");
    expect(result.appliedEffect!.duration).toBe(2);
  });

  it("damage skill can defeat target", () => {
    const weak: CombatParticipant = { ...target, hp: 5 };
    const result = resolveSkill(actor, weak, "damage", 20, 20);

    expect(result.defeated).toBe(true);
    expect(result.newTargetHp).toBe(0);
  });

  it("uses default magnitude when not provided", () => {
    const result = resolveSkill(actor, target, "damage", 10);

    // baseMag(10) * 0.6 + 10 * 0.5 = 6 + 5 = 11
    expect(result.effectValue).toBe(11);
  });
});

// ── advanceTurn ────────────────────────────────────────────────────

describe("advanceTurn", () => {
  it("advances to next participant", () => {
    const state = createTestCombat();

    const advanced = advanceTurn(state);

    expect(advanced.currentTurnIndex).toBe(1);
    expect(advanced.roundNumber).toBe(1);
  });

  it("wraps around and increments round", () => {
    const state: CombatState = {
      ...createTestCombat(),
      currentTurnIndex: 2, // last participant
    };

    const advanced = advanceTurn(state);

    expect(advanced.currentTurnIndex).toBe(0);
    expect(advanced.roundNumber).toBe(2);
  });

  it("skips defeated participants", () => {
    let state = createTestCombat();
    // Defeat the second participant
    state = updateParticipant(state, state.turnOrder[1]!.id, {
      isDefeated: true,
    });

    const advanced = advanceTurn(state);

    // Should skip index 1 and go to index 2
    expect(advanced.currentTurnIndex).toBe(2);
  });

  it("handles all participants defeated", () => {
    let state = createTestCombat();
    for (const p of state.turnOrder) {
      state = updateParticipant(state, p.id, { isDefeated: true });
    }

    const advanced = advanceTurn(state);

    // Should not change when nobody is alive
    expect(advanced.currentTurnIndex).toBe(state.currentTurnIndex);
  });
});

// ── tickStatusDurations ────────────────────────────────────────────

describe("tickStatusDurations", () => {
  it("decrements status effect durations", () => {
    const participant: CombatParticipant = {
      id: "p1",
      name: "Test",
      type: "player",
      hp: 50,
      maxHp: 50,
      initiative: 10,
      isDefeated: false,
      statusEffects: [
        { id: "buff_1", name: "Empowered", duration: 3, effect: {} },
      ],
    };

    const state: CombatState = {
      active: true,
      roundNumber: 1,
      turnOrder: [participant],
      currentTurnIndex: 0,
      log: [],
      startedTurnId: "turn_001",
    };

    const ticked = tickStatusDurations(state);

    expect(ticked.turnOrder[0]!.statusEffects[0]!.duration).toBe(2);
  });

  it("removes expired status effects", () => {
    const participant: CombatParticipant = {
      id: "p1",
      name: "Test",
      type: "player",
      hp: 50,
      maxHp: 50,
      initiative: 10,
      isDefeated: false,
      statusEffects: [
        { id: "buff_1", name: "Empowered", duration: 1, effect: {} },
        { id: "poison_1", name: "Poison", duration: 3, effect: {} },
      ],
    };

    const state: CombatState = {
      active: true,
      roundNumber: 1,
      turnOrder: [participant],
      currentTurnIndex: 0,
      log: [],
      startedTurnId: "turn_001",
    };

    const ticked = tickStatusDurations(state);

    expect(ticked.turnOrder[0]!.statusEffects).toHaveLength(1);
    expect(ticked.turnOrder[0]!.statusEffects[0]!.name).toBe("Poison");
  });

  it("does not mutate original state", () => {
    const state = createTestCombat();
    const ticked = tickStatusDurations(state);

    expect(ticked).not.toBe(state);
    expect(ticked.turnOrder).not.toBe(state.turnOrder);
  });
});

// ── isCombatOver ───────────────────────────────────────────────────

describe("isCombatOver", () => {
  it("returns not over when both sides have alive participants", () => {
    const state = createTestCombat();

    const result = isCombatOver(state);

    expect(result.over).toBe(false);
    expect(result.winner).toBeNull();
  });

  it("returns player victory when all enemies defeated", () => {
    let state = createTestCombat();
    state = updateParticipant(state, "enemy_1", { isDefeated: true });

    const result = isCombatOver(state);

    expect(result.over).toBe(true);
    expect(result.winner).toBe("player");
  });

  it("returns enemy victory when all player/allies defeated", () => {
    let state = createTestCombat();
    state = updateParticipant(state, "player_1", { isDefeated: true });
    state = updateParticipant(state, "ally_1", { isDefeated: true });

    const result = isCombatOver(state);

    expect(result.over).toBe(true);
    expect(result.winner).toBe("enemy");
  });

  it("returns draw when both sides defeated", () => {
    let state = createTestCombat();
    state = updateParticipant(state, "player_1", { isDefeated: true });
    state = updateParticipant(state, "ally_1", { isDefeated: true });
    state = updateParticipant(state, "enemy_1", { isDefeated: true });

    const result = isCombatOver(state);

    expect(result.over).toBe(true);
    expect(result.winner).toBe("draw");
  });
});

// ── getCombatSummary ───────────────────────────────────────────────

describe("getCombatSummary", () => {
  it("returns Chinese summary for zh-CN locale", () => {
    const state = createTestCombat();
    const summary = getCombatSummary(state, "zh-CN");

    expect(summary).toContain("回合");
    expect(summary).toContain("Hero");
    expect(summary).toContain("Goblin");
    expect(summary).toContain("HP");
  });

  it("returns English summary for en-US locale", () => {
    const state = createTestCombat();
    const summary = getCombatSummary(state, "en-US");

    expect(summary).toContain("Round");
    expect(summary).toContain("Hero");
    expect(summary).toContain("100/100 HP");
  });

  it("marks current actor with arrow", () => {
    const state = createTestCombat();
    const summary = getCombatSummary(state, "en-US");
    const currentActor = state.turnOrder[0]!;

    expect(summary).toContain(`${currentActor.name}`);
    expect(summary).toContain("◄");
  });

  it("shows DEFEATED for eliminated participants", () => {
    let state = createTestCombat();
    state = updateParticipant(state, "enemy_1", {
      isDefeated: true,
      hp: 0,
    });

    const summary = getCombatSummary(state, "en-US");

    expect(summary).toContain("DEFEATED");
  });

  it("shows status effects with duration", () => {
    let state = createTestCombat();
    const defended = applyDefense(state.turnOrder[0]!);
    state = updateParticipant(state, state.turnOrder[0]!.id, {
      statusEffects: defended.statusEffects,
    });

    const summary = getCombatSummary(state, "en-US");

    expect(summary).toContain("Defending(1)");
  });
});

// ── buildCombatStatusBlock ─────────────────────────────────────────

describe("buildCombatStatusBlock", () => {
  it("builds block with correct structure", () => {
    const state = createTestCombat();
    const block = buildCombatStatusBlock(state);

    expect(block.roundNumber).toBe(1);
    expect(block.currentActor).toBe(state.turnOrder[0]!.name);
    expect(block.participants).toHaveLength(3);
  });

  it("includes participant details", () => {
    const state = createTestCombat();
    const block = buildCombatStatusBlock(state);

    const player = block.participants.find((p) => p.id === "player_1")!;
    expect(player.name).toBe("Hero");
    expect(player.hp).toBe(100);
    expect(player.maxHp).toBe(100);
    expect(player.isDefeated).toBe(false);
  });
});

// ── appendLog ──────────────────────────────────────────────────────

describe("appendLog", () => {
  it("appends a log entry immutably", () => {
    const state = createTestCombat();
    const entry = {
      round: 1,
      actorId: "player_1",
      action: "attack",
      targetId: "enemy_1",
      result: "Hit!",
      damage: 10,
    };

    const updated = appendLog(state, entry);

    expect(updated.log).toHaveLength(1);
    expect(updated.log[0]).toEqual(entry);
    expect(state.log).toHaveLength(0); // original unchanged
  });
});

// ── Plugin Registration ────────────────────────────────────────────

describe("register", () => {
  it("registers all tools and context provider", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    register(registrar);

    expect(contributions.tools.has("start-combat")).toBe(true);
    expect(contributions.tools.has("attack")).toBe(true);
    expect(contributions.tools.has("defend")).toBe(true);
    expect(contributions.tools.has("use-skill")).toBe(true);
    expect(contributions.tools.has("end-combat")).toBe(true);
    expect(contributions.contextProviders.has("combat-status")).toBe(true);
    expect(contributions.runtimeHandlers.size).toBe(0);
    expect(contributions.hooks.size).toBe(0);
  });
});

// ── Tool Handlers ──────────────────────────────────────────────────

describe("startCombatTool", () => {
  it("initializes combat with proposals", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("start-combat")!;
    const ctx = createMockToolContext({
      input: {
        participants: [
          { id: "p1", name: "Hero", type: "player", hp: 100, maxHp: 100 },
          { id: "e1", name: "Goblin", type: "enemy", hp: 30, maxHp: 30 },
        ],
        initiativeRolls: [15, 8],
      },
    });

    const result = await tool(ctx);

    expect(result.proposals).toBeDefined();
    assertProposalContains(result.proposals!, [
      "state.patch",
      "event.emit",
      "ui.render",
    ]);

    const statePatch = findProposal<{ combat: CombatState }>(
      result.proposals!,
      "state.patch"
    );
    expect(statePatch?.combat.active).toBe(true);
    expect(statePatch?.combat.turnOrder).toHaveLength(2);
  });

  it("returns error when no participants provided", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("start-combat")!;
    const ctx = createMockToolContext({
      input: { participants: [] },
    });

    const result = await tool(ctx);

    expect((result.output as Record<string, unknown>).error).toBeDefined();
  });
});

describe("attackTool", () => {
  it("resolves attack and produces proposals", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const combat = initCombat(
      [
        { id: "p1", name: "Hero", type: "player", hp: 100, maxHp: 100 },
        { id: "e1", name: "Goblin", type: "enemy", hp: 30, maxHp: 30 },
      ],
      [15, 8],
      "turn_001"
    );

    const tool = contributions.tools.get("attack")!;
    const ctx = {
      ...createMockToolContext({
        input: { attackerId: "p1", targetId: "e1", rollResult: 10 },
      }),
      state: { combat },
    } as unknown as Parameters<typeof tool>[0];

    const result = await tool(ctx);

    expect(result.proposals).toBeDefined();
    assertProposalContains(result.proposals!, [
      "state.patch",
      "event.emit",
      "ui.render",
    ]);

    const output = result.output as Record<string, unknown>;
    expect(output.damage).toBe(10);
    expect(output.defeated).toBe(false);
  });

  it("returns error when no active combat", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("attack")!;
    const ctx = createMockToolContext({
      input: { attackerId: "p1", targetId: "e1", rollResult: 10 },
    });

    const result = await tool(ctx);

    expect((result.output as Record<string, unknown>).error).toBeDefined();
  });
});

describe("defendTool", () => {
  it("applies defense and produces state patch", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const combat = initCombat(
      [
        { id: "p1", name: "Hero", type: "player", hp: 100, maxHp: 100 },
        { id: "e1", name: "Goblin", type: "enemy", hp: 30, maxHp: 30 },
      ],
      [15, 8],
      "turn_001"
    );

    const tool = contributions.tools.get("defend")!;
    const ctx = {
      ...createMockToolContext({
        input: { participantId: "p1" },
      }),
      state: { combat },
    } as unknown as Parameters<typeof tool>[0];

    const result = await tool(ctx);

    expect(result.proposals).toBeDefined();
    const statePatch = findProposal<{ combat: CombatState }>(
      result.proposals!,
      "state.patch"
    );
    expect(statePatch).toBeDefined();

    const updatedPlayer = statePatch!.combat.turnOrder.find(
      (p) => p.id === "p1"
    )!;
    expect(
      updatedPlayer.statusEffects.some((e) => e.id === "defending")
    ).toBe(true);
  });
});

describe("useSkillTool", () => {
  it("resolves damage skill and produces proposals", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const combat = initCombat(
      [
        { id: "p1", name: "Mage", type: "player", hp: 80, maxHp: 80 },
        { id: "e1", name: "Orc", type: "enemy", hp: 50, maxHp: 50 },
      ],
      [15, 8],
      "turn_001"
    );

    const tool = contributions.tools.get("use-skill")!;
    const ctx = {
      ...createMockToolContext({
        input: {
          actorId: "p1",
          targetId: "e1",
          skillName: "Fireball",
          skillType: "damage",
          rollResult: 12,
          magnitude: 20,
        },
      }),
      state: { combat },
    } as unknown as Parameters<typeof tool>[0];

    const result = await tool(ctx);

    expect(result.proposals).toBeDefined();
    assertProposalContains(result.proposals!, [
      "state.patch",
      "event.emit",
      "ui.render",
    ]);

    const output = result.output as Record<string, unknown>;
    expect(typeof output.effectValue).toBe("number");
    expect((output.effectValue as number)).toBeGreaterThan(0);
  });

  it("resolves heal skill correctly", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const combat = initCombat(
      [
        { id: "p1", name: "Healer", type: "player", hp: 80, maxHp: 80 },
        { id: "p2", name: "Wounded", type: "ally", hp: 20, maxHp: 60 },
      ],
      [15, 8],
      "turn_001"
    );

    const tool = contributions.tools.get("use-skill")!;
    const ctx = {
      ...createMockToolContext({
        input: {
          actorId: "p1",
          targetId: "p2",
          skillName: "Heal",
          skillType: "heal",
          rollResult: 10,
        },
      }),
      state: { combat },
    } as unknown as Parameters<typeof tool>[0];

    const result = await tool(ctx);

    const output = result.output as Record<string, unknown>;
    expect((output.newTargetHp as number)).toBeGreaterThan(20);
    expect((output.newTargetHp as number)).toBeLessThanOrEqual(60);
  });
});

describe("endCombatTool", () => {
  it("ends combat with proposals", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const combat = initCombat(
      [
        { id: "p1", name: "Hero", type: "player", hp: 100, maxHp: 100 },
        { id: "e1", name: "Goblin", type: "enemy", hp: 0, maxHp: 30 },
      ],
      [15, 8],
      "turn_001"
    );

    const tool = contributions.tools.get("end-combat")!;
    const ctx = {
      ...createMockToolContext({
        input: { reason: "victory" },
      }),
      state: { combat },
    } as unknown as Parameters<typeof tool>[0];

    const result = await tool(ctx);

    expect(result.proposals).toBeDefined();
    assertProposalContains(result.proposals!, [
      "state.patch",
      "event.emit",
      "narrative.append",
    ]);

    const statePatch = findProposal<{ combat: CombatState }>(
      result.proposals!,
      "state.patch"
    );
    expect(statePatch?.combat.active).toBe(false);

    const narrative = findProposal<{ text: string }>(
      result.proposals!,
      "narrative.append"
    );
    expect(narrative?.text).toContain("击败");
  });

  it("generates Chinese narrative for zh-CN locale", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const combat = initCombat(
      [
        { id: "p1", name: "Hero", type: "player", hp: 100, maxHp: 100 },
        { id: "e1", name: "Goblin", type: "enemy", hp: 0, maxHp: 30 },
      ],
      [15, 8],
      "turn_001"
    );

    const tool = contributions.tools.get("end-combat")!;
    const ctx = {
      ...createMockToolContext({
        input: { reason: "retreat" },
        locale: "zh-CN",
      }),
      state: { combat },
    } as unknown as Parameters<typeof tool>[0];

    const result = await tool(ctx);

    const narrative = findProposal<{ text: string }>(
      result.proposals!,
      "narrative.append"
    );
    expect(narrative?.text).toContain("撤退");
  });
});

// ── Context Provider ───────────────────────────────────────────────

describe("combatContextProvider", () => {
  it("returns combat context when combat is active", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("combat-status")!;
    const combat = createTestCombat();

    const input = createMockProviderInput({
      state: { combat },
    });

    const result = (await provider(input)) as {
      id: string;
      title: string;
      content: string;
      priority: number;
    };

    expect(result).not.toBeNull();
    expect(result.id).toBe("combat-status");
    expect(result.priority).toBe(90);
    expect(result.content).toContain("Hero");
    expect(result.content).toContain("Goblin");
  });

  it("returns null when no combat state exists", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("combat-status")!;
    const input = createMockProviderInput({ state: {} });

    const result = await provider(input);

    expect(result).toBeNull();
  });

  it("returns null when combat is not active", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("combat-status")!;
    const combat: CombatState = {
      ...createTestCombat(),
      active: false,
    };

    const input = createMockProviderInput({
      state: { combat },
    });

    const result = await provider(input);

    expect(result).toBeNull();
  });

  it("returns Chinese context for zh-CN locale", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("combat-status")!;
    const combat = createTestCombat();

    const input = createMockProviderInput({
      state: { combat },
      locale: "zh-CN",
    });

    const result = (await provider(input)) as {
      content: string;
      title: string;
    };

    expect(result.title).toBe("战斗状态");
    expect(result.content).toContain("战斗规则");
  });

  it("returns English context for en-US locale", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("combat-status")!;
    const combat = createTestCombat();

    const input = createMockProviderInput({
      state: { combat },
      locale: "en-US",
    });

    const result = (await provider(input)) as {
      content: string;
      title: string;
    };

    expect(result.title).toBe("Combat Status");
    expect(result.content).toContain("Combat Rules");
  });
});
