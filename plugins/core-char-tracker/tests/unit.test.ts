import { describe, it, expect } from "vitest";
import {
  createMockHandlerContext,
  createCollectingRegistrar,
  findProposal,
  findProposals,
  assertProposalContains,
} from "@covel/plugin-test-utils";
import type { CharacterCard } from "@covel/shared";
import {
  extractChineseNames,
  extractEnglishNames,
  isCommonPhrase,
  inferRole,
  inferDescription,
  buildUpdatedCard,
  buildNewCard,
  buildRelationshipProposals,
  PLUGIN_ID,
} from "../server/logic.js";
import type { TrackerExtension } from "../server/logic.js";
import register from "../server/index.js";

// ── extractChineseNames ───────────────────────────────────────────

describe("extractChineseNames", () => {
  it("extracts names from speech patterns with 说", () => {
    // Pattern: 2-char name + 说 (not 说道, which shifts the capture)
    const text = `李明说：\u201C今天天气不错。\u201D`;
    const names = extractChineseNames(text);
    expect(names).toContain("李明");
  });

  it("extracts names from 问 pattern", () => {
    const text = `王大妈问：\u201C你是谁？\u201D`;
    const names = extractChineseNames(text);
    expect(names).toContain("王大妈");
  });

  it("extracts names from 笑 pattern", () => {
    // 张三笑 -> group1="张三", group2="笑"
    const text = `张三笑着走了过来。`;
    const names = extractChineseNames(text);
    expect(names).toContain("张三");
  });

  it("extracts names from 叹 pattern", () => {
    const text = `老陈叹了口气。`;
    const names = extractChineseNames(text);
    expect(names).toContain("老陈");
  });

  it("extracts names from 喊 and 叫 patterns", () => {
    // Verbs directly after name without intermediate characters
    const text = `小红喊住了他。阿强叫住了她。`;
    const names = extractChineseNames(text);
    expect(names).toContain("小红");
    expect(names).toContain("阿强");
  });

  it("extracts names from directional patterns (看向/点头/摇头)", () => {
    const text = `林姐看向远方。赵四点头表示同意。`;
    const names = extractChineseNames(text);
    expect(names).toContain("林姐");
    expect(names).toContain("赵四");
  });

  it("extracts names from 低声/冷声/沉声 patterns", () => {
    // 3-char name + 2-char verb works because {2,4} greedy tries 4 first
    // 柳如烟低声 -> tries 4 "柳如烟低"+"声"(no) -> tries 3 "柳如烟"+"低声"(yes!)
    // For 2-char names, use comma separator so verb is matched directly
    const text = `柳如烟低声说了句话。最后，萧剑冷声回应。`;
    const names = extractChineseNames(text);
    expect(names).toContain("柳如烟");
    // ，萧剑冷声 -> comma breaks the run, tries "萧剑"+"冷声" = match
    expect(names).toContain("萧剑");
  });

  it("deduplicates repeated names", () => {
    const text = `李明说道：\u201C你好。\u201D过了一会儿，李明说：\u201C再见。\u201D`;
    const names = extractChineseNames(text);
    const liMingCount = names.filter((n) => n === "李明").length;
    expect(liMingCount).toBe(1);
  });

  it("filters out common phrases", () => {
    const text = `因为说了些什么。然后道了声谢。`;
    const names = extractChineseNames(text);
    expect(names).not.toContain("因为");
    expect(names).not.toContain("然后");
  });

  it("returns empty array when no names found", () => {
    const text = `今天天气很好，阳光明媚。`;
    const names = extractChineseNames(text);
    expect(names).toEqual([]);
  });

  it("handles multiple characters in dialogue", () => {
    // Use patterns where verb directly follows name
    const text = `李明说了句话。王芳答了一声。赵刚笑着离开。`;
    const names = extractChineseNames(text);
    expect(names).toContain("李明");
    expect(names).toContain("王芳");
    expect(names).toContain("赵刚");
    expect(names).toHaveLength(3);
  });
});

// ── extractEnglishNames ───────────────────────────────────────────

describe("extractEnglishNames", () => {
  it("extracts name from 'said' pattern", () => {
    const text = `John said "Hello there."`;
    const names = extractEnglishNames(text);
    expect(names).toContain("John");
  });

  it("extracts name from 'asked' pattern", () => {
    const text = `Lady Blackwood asked "Who goes there?"`;
    const names = extractEnglishNames(text);
    expect(names).toContain("Lady Blackwood");
  });

  it("extracts names from multiple speech verbs", () => {
    // Avoid "Then Sarah" being captured as a two-word name
    const text =
      `Elena whispered something. Marcus shouted a warning. Sarah replied calmly.`;
    const names = extractEnglishNames(text);
    expect(names).toContain("Elena");
    expect(names).toContain("Marcus");
    expect(names).toContain("Sarah");
  });

  it("extracts names from action verbs (nodded, smiled, looked, turned)", () => {
    const text = `Arthur nodded solemnly. Gwen smiled at the crowd. Henry looked away. Morgan turned around.`;
    const names = extractEnglishNames(text);
    expect(names).toContain("Arthur");
    expect(names).toContain("Gwen");
    expect(names).toContain("Henry");
    expect(names).toContain("Morgan");
  });

  it("extracts two-word names", () => {
    const text = `Sir Lancelot laughed heartily.`;
    const names = extractEnglishNames(text);
    expect(names).toContain("Sir Lancelot");
  });

  it("deduplicates repeated names", () => {
    const text = `John said "Hi." Then John said "Bye."`;
    const names = extractEnglishNames(text);
    const johnCount = names.filter((n) => n === "John").length;
    expect(johnCount).toBe(1);
  });

  it("returns empty array when no names found", () => {
    const text = `the weather was nice and sunny.`;
    const names = extractEnglishNames(text);
    expect(names).toEqual([]);
  });

  it("does not match lowercase words", () => {
    const text = `someone said something quietly.`;
    const names = extractEnglishNames(text);
    expect(names).toEqual([]);
  });
});

// ── isCommonPhrase ────────────────────────────────────────────────

describe("isCommonPhrase", () => {
  it("returns true for common Chinese conjunctions", () => {
    expect(isCommonPhrase("但是")).toBe(true);
    expect(isCommonPhrase("因为")).toBe(true);
    expect(isCommonPhrase("然后")).toBe(true);
    expect(isCommonPhrase("所以")).toBe(true);
    expect(isCommonPhrase("如果")).toBe(true);
    expect(isCommonPhrase("虽然")).toBe(true);
  });

  it("returns true for common Chinese pronouns", () => {
    expect(isCommonPhrase("他们")).toBe(true);
    expect(isCommonPhrase("她们")).toBe(true);
    expect(isCommonPhrase("我们")).toBe(true);
    expect(isCommonPhrase("你们")).toBe(true);
  });

  it("returns true for common Chinese demonstratives", () => {
    expect(isCommonPhrase("这个")).toBe(true);
    expect(isCommonPhrase("那个")).toBe(true);
    expect(isCommonPhrase("什么")).toBe(true);
  });

  it("returns true for common adverbs", () => {
    expect(isCommonPhrase("已经")).toBe(true);
    expect(isCommonPhrase("可以")).toBe(true);
    expect(isCommonPhrase("应该")).toBe(true);
    expect(isCommonPhrase("不过")).toBe(true);
    expect(isCommonPhrase("只是")).toBe(true);
  });

  it("returns false for actual character names", () => {
    expect(isCommonPhrase("李明")).toBe(false);
    expect(isCommonPhrase("王大妈")).toBe(false);
    expect(isCommonPhrase("张三")).toBe(false);
    expect(isCommonPhrase("柳如烟")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCommonPhrase("")).toBe(false);
  });
});

// ── inferRole ─────────────────────────────────────────────────────

describe("inferRole", () => {
  it("returns npc when Chinese narrative contains 你", () => {
    const result = inferRole("李明", "你看到李明走了过来。", true);
    expect(result).toBe("npc");
  });

  it("returns npc when English narrative contains 'you'", () => {
    const result = inferRole("John", "You see John approaching.", false);
    expect(result).toBe("npc");
  });

  it("returns unknown when no second-person reference in Chinese", () => {
    const result = inferRole("李明", "李明走了过来。", true);
    expect(result).toBe("unknown");
  });

  it("returns unknown when no second-person reference in English", () => {
    const result = inferRole("John", "John approached the gate.", false);
    expect(result).toBe("unknown");
  });

  it("matches 'you' case-insensitively in English", () => {
    const result = inferRole("John", "YOU shall not pass!", false);
    expect(result).toBe("npc");
  });

  it("does not match 'you' as part of another word", () => {
    const result = inferRole("John", "John played with the young cat.", false);
    expect(result).toBe("unknown");
  });
});

// ── inferDescription ──────────────────────────────────────────────

describe("inferDescription", () => {
  it("extracts sentence containing character name (Chinese)", () => {
    const narrative = `天色已晚。李明是一个身穿白衣的年轻剑客。他走入了酒馆。`;
    const desc = inferDescription("李明", narrative, true);
    expect(desc).toContain("李明");
    expect(desc.length).toBeGreaterThan(10);
  });

  it("extracts sentence containing character name (English)", () => {
    const narrative = `The sun set. John was a tall warrior with a scarred face. He entered the inn.`;
    const desc = inferDescription("John", narrative, false);
    expect(desc).toContain("John");
  });

  it("returns default Chinese description when no suitable sentence found", () => {
    const desc = inferDescription("李明", "短。", true);
    expect(desc).toBe("在叙事中出现的角色");
  });

  it("returns default English description when no suitable sentence found", () => {
    const desc = inferDescription("John", "Hi.", false);
    expect(desc).toBe("A character mentioned in the narrative");
  });

  it("skips sentences that are too short (<=10 chars)", () => {
    const narrative = `李明好。李明是一位来自东方的年轻剑客，他有着敏锐的眼光和不凡的身手。`;
    const desc = inferDescription("李明", narrative, true);
    expect(desc.length).toBeGreaterThan(10);
  });

  it("skips sentences that are too long (>=100 chars)", () => {
    const long = "李明" + "非常".repeat(50) + "厉害";
    const narrative = `${long}。李明是一位来自东方的年轻剑客。`;
    const desc = inferDescription("李明", narrative, true);
    expect(desc).toContain("李明");
    expect(desc.length).toBeLessThan(100);
  });
});

// ── buildUpdatedCard ──────────────────────────────────────────────

describe("buildUpdatedCard", () => {
  const baseCard: CharacterCard = {
    id: "char_001",
    worldId: "world_test",
    runId: "run_test",
    name: "李明",
    type: "npc",
    description: "一个年轻人",
    fields: {},
    extensions: {
      [PLUGIN_ID]: {
        firstSeenTurn: "turn_001",
        lastSeenTurn: "turn_001",
        mentionCount: 1,
      } satisfies TrackerExtension,
    },
    createdAt: "2024-01-01T00:00:00.000Z",
    version: 1,
  };

  it("increments version", () => {
    const updated = buildUpdatedCard(baseCard, "turn_002");
    expect(updated.version).toBe(2);
  });

  it("increments mention count", () => {
    const updated = buildUpdatedCard(baseCard, "turn_002");
    const ext = updated.extensions[PLUGIN_ID] as TrackerExtension;
    expect(ext.mentionCount).toBe(2);
  });

  it("updates lastSeenTurn", () => {
    const updated = buildUpdatedCard(baseCard, "turn_002");
    const ext = updated.extensions[PLUGIN_ID] as TrackerExtension;
    expect(ext.lastSeenTurn).toBe("turn_002");
  });

  it("preserves firstSeenTurn", () => {
    const updated = buildUpdatedCard(baseCard, "turn_002");
    const ext = updated.extensions[PLUGIN_ID] as TrackerExtension;
    expect(ext.firstSeenTurn).toBe("turn_001");
  });

  it("does not mutate the original card", () => {
    const updated = buildUpdatedCard(baseCard, "turn_002");
    expect(baseCard.version).toBe(1);
    expect(updated).not.toBe(baseCard);
    expect(updated.extensions).not.toBe(baseCard.extensions);
  });

  it("handles card with no existing tracker extension", () => {
    const cardNoExt: CharacterCard = { ...baseCard, extensions: {} };
    const updated = buildUpdatedCard(cardNoExt, "turn_002");
    const ext = updated.extensions[PLUGIN_ID] as TrackerExtension;
    expect(ext.mentionCount).toBe(1);
    expect(ext.lastSeenTurn).toBe("turn_002");
  });
});

// ── buildNewCard ──────────────────────────────────────────────────

describe("buildNewCard", () => {
  it("creates card with correct basic fields", () => {
    const card = buildNewCard("李明", "你看到李明走了过来。", true, "turn_001", "run_1", "world_1");
    expect(card.name).toBe("李明");
    expect(card.runId).toBe("run_1");
    expect(card.worldId).toBe("world_1");
    expect(card.version).toBe(1);
    expect(card.id).toBe("");
  });

  it("sets type to npc when narrative has second-person reference", () => {
    const card = buildNewCard("李明", "你看到李明走了过来。", true, "turn_001", "run_1", "world_1");
    expect(card.type).toBe("npc");
  });

  it("sets type to npc for unknown role (not protagonist)", () => {
    const card = buildNewCard("李明", "李明走了过来。", true, "turn_001", "run_1", "world_1");
    expect(card.type).toBe("npc");
  });

  it("initializes tracker extension with mentionCount 1", () => {
    const card = buildNewCard("李明", "你看到李明走了过来。", true, "turn_001", "run_1", "world_1");
    const ext = card.extensions[PLUGIN_ID] as TrackerExtension;
    expect(ext.mentionCount).toBe(1);
    expect(ext.firstSeenTurn).toBe("turn_001");
    expect(ext.lastSeenTurn).toBe("turn_001");
  });

  it("sets createdAt to a valid ISO string", () => {
    const card = buildNewCard("John", "You see John.", false, "turn_001", "run_1", "world_1");
    expect(new Date(card.createdAt).toISOString()).toBe(card.createdAt);
  });
});

// ── buildRelationshipProposals ────────────────────────────────────

describe("buildRelationshipProposals", () => {
  it("builds one proposal for two names", () => {
    const proposals = buildRelationshipProposals(["李明", "王芳"], "turn_001");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.kind).toBe("record.upsert");
    expect(proposals[0]!.payload.recordType).toBe("character_relationship");
    expect(proposals[0]!.payload.value.fromCharacterName).toBe("李明");
    expect(proposals[0]!.payload.value.toCharacterName).toBe("王芳");
  });

  it("builds three proposals for three names (combinatorial)", () => {
    const proposals = buildRelationshipProposals(["A", "B", "C"], "turn_001");
    expect(proposals).toHaveLength(3);
  });

  it("builds six proposals for four names", () => {
    const proposals = buildRelationshipProposals(["A", "B", "C", "D"], "turn_001");
    expect(proposals).toHaveLength(6);
  });

  it("returns empty array for single name", () => {
    const proposals = buildRelationshipProposals(["李明"], "turn_001");
    expect(proposals).toEqual([]);
  });

  it("returns empty array for empty list", () => {
    const proposals = buildRelationshipProposals([], "turn_001");
    expect(proposals).toEqual([]);
  });

  it("sets lastInteractionTurnId correctly", () => {
    const proposals = buildRelationshipProposals(["A", "B"], "turn_042");
    expect(proposals[0]!.payload.value.lastInteractionTurnId).toBe("turn_042");
  });
});

// ── Plugin Registration ───────────────────────────────────────────

describe("register", () => {
  it("registers char-tracker runtime handler", () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    expect(contributions.runtimeHandlers.has("char-tracker")).toBe(true);
    expect(contributions.tools.size).toBe(0);
    expect(contributions.hooks.size).toBe(0);
    expect(contributions.contextProviders.size).toBe(0);
    expect(contributions.commands).toHaveLength(0);
  });
});

// ── Handler Integration ───────────────────────────────────────────

describe("charTrackerHandler (via register)", () => {
  async function runHandler(
    narrative: string,
    locale: string,
    existingCharacters: CharacterCard[] = []
  ) {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);
    const handler = contributions.runtimeHandlers.get("char-tracker")!;

    const ctx = createMockHandlerContext({
      contextOverrides: {
        narrative: { content: narrative, messageId: "msg_001" },
        characters: existingCharacters,
        run: {
          runId: "run_test_001",
          worldId: "world_test",
          branchId: "branch_main",
          turnId: "turn_001",
          status: "active",
          phase: "playing",
          defaultLocale: locale,
          activeBranchId: "branch_main",
        },
        locale,
      },
      locale,
    });

    return handler(ctx);
  }

  it("returns empty proposals when narrative is empty", async () => {
    const result = await runHandler("", "zh-CN");
    expect(result.proposals).toEqual([]);
  });

  it("returns empty proposals when no characters found in narrative", async () => {
    const result = await runHandler("今天天气很好，阳光明媚。", "zh-CN");
    expect(result.proposals).toEqual([]);
  });

  it("extracts Chinese characters and produces record.upsert + state.patch", async () => {
    const result = await runHandler(
      `李明说了句你好。王芳答了一声。`,
      "zh-CN"
    );

    assertProposalContains(result.proposals, ["record.upsert", "state.patch"]);

    const upserts = findProposals<{ key: string; value: CharacterCard }>(
      result.proposals,
      "record.upsert"
    );
    const charUpserts = upserts.filter((u) => u.key.startsWith("character:"));
    expect(charUpserts).toHaveLength(2);

    const names = charUpserts.map((u) => u.value.name);
    expect(names).toContain("李明");
    expect(names).toContain("王芳");
  });

  it("extracts English characters and produces proposals", async () => {
    const result = await runHandler(
      `John said "Hello." Mary replied "Hi there."`,
      "en-US"
    );

    assertProposalContains(result.proposals, ["record.upsert", "state.patch"]);

    const upserts = findProposals<{ key: string; value: CharacterCard }>(
      result.proposals,
      "record.upsert"
    );
    const charUpserts = upserts.filter((u) => u.key.startsWith("character:"));
    expect(charUpserts).toHaveLength(2);

    const names = charUpserts.map((u) => u.value.name);
    expect(names).toContain("John");
    expect(names).toContain("Mary");
  });

  it("updates existing character with incremented version and mention count", async () => {
    const existingCard: CharacterCard = {
      id: "char_001",
      worldId: "world_test",
      runId: "run_test_001",
      name: "李明",
      type: "npc",
      description: "一个年轻人",
      fields: {},
      extensions: {
        [PLUGIN_ID]: {
          firstSeenTurn: "turn_000",
          lastSeenTurn: "turn_000",
          mentionCount: 3,
        } satisfies TrackerExtension,
      },
      createdAt: "2024-01-01T00:00:00.000Z",
      version: 3,
    };

    const result = await runHandler(
      `李明说了句话。`,
      "zh-CN",
      [existingCard]
    );

    const upserts = findProposals<{ key: string; value: CharacterCard }>(
      result.proposals,
      "record.upsert"
    );
    const liMing = upserts.find((u) => u.key === "character:李明");
    expect(liMing).toBeDefined();
    expect(liMing!.value.version).toBe(4);
    const ext = liMing!.value.extensions[PLUGIN_ID] as TrackerExtension;
    expect(ext.mentionCount).toBe(4);
    expect(ext.lastSeenTurn).toBe("turn_001");
    expect(ext.firstSeenTurn).toBe("turn_000");
  });

  it("produces relationship proposals when multiple characters co-occur", async () => {
    const result = await runHandler(
      `李明说了句话。王芳答了一声。赵刚笑着离开。`,
      "zh-CN"
    );

    const relProposals = findProposals<{ key: string; recordType: string }>(
      result.proposals,
      "record.upsert"
    ).filter((u) => u.recordType === "character_relationship");

    // 3 characters = 3 relationship pairs
    expect(relProposals).toHaveLength(3);
  });

  it("produces state.patch with all characters (existing + new)", async () => {
    const existingCard: CharacterCard = {
      id: "char_existing",
      worldId: "world_test",
      runId: "run_test_001",
      name: "老王",
      type: "npc",
      description: "一个老人",
      fields: {},
      extensions: {},
      createdAt: "2024-01-01T00:00:00.000Z",
      version: 1,
    };

    const result = await runHandler(
      `李明说了句话。`,
      "zh-CN",
      [existingCard]
    );

    const statePatch = findProposal<{ characters: Record<string, CharacterCard> }>(
      result.proposals,
      "state.patch"
    );
    expect(statePatch).toBeDefined();
    expect(statePatch!.characters["老王"]).toBeDefined();
    expect(statePatch!.characters["李明"]).toBeDefined();
  });
});
