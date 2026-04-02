import { describe, it, expect } from "vitest";
import {
  LIVE,
  createMockHandlerContext,
  createCollectingRegistrar,
  findProposals,
} from "@covel/plugin-test-utils";
import type { CharacterCard } from "@covel/shared";
import register from "../server/index.js";

/**
 * Live tests for core-char-tracker.
 *
 * The char-tracker handler uses regex-based extraction (no LLM),
 * so these tests verify the handler works correctly with realistic
 * narrative content that might come from an LLM-generated story.
 * Skipped unless LIVE_LLM_ENABLED=1.
 */
describe.skipIf(!LIVE)("live: core-char-tracker", () => {
  it("extracts characters from a realistic Chinese narrative", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);
    const handler = contributions.runtimeHandlers.get("char-tracker")!;

    const narrative = [
      "夜幕降临，酒馆里灯火通明。",
      `林逸尘低声道：\u201C今晚的任务很危险，你确定要去？\u201D`,
      `苏婉清笑了笑，回答说：\u201C我什么时候退缩过？\u201D`,
      `一旁的老张叹了口气，说道：\u201C年轻人总是这么冲动。\u201D`,
      "你看向三人，心中暗自盘算着接下来的计划。",
    ].join("\n");

    const ctx = createMockHandlerContext({
      contextOverrides: {
        narrative: { content: narrative, messageId: "msg_live" },
        run: {
          runId: "run_live",
          worldId: "world_live",
          branchId: "branch_main",
          turnId: "turn_live_001",
          status: "active",
          phase: "playing",
          defaultLocale: "zh-CN",
          activeBranchId: "branch_main",
        },
        locale: "zh-CN",
      },
      locale: "zh-CN",
    });

    const result = await handler(ctx);

    const upserts = findProposals<{ key: string; value: CharacterCard }>(
      result.proposals,
      "record.upsert"
    );
    const charUpserts = upserts.filter((u) => u.key.startsWith("character:"));
    const names = charUpserts.map((u) => u.value.name);

    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names).toContain("林逸尘");
    expect(names).toContain("苏婉清");
    expect(names).toContain("老张");

    // All extracted characters should be NPCs (narrative contains 你)
    for (const u of charUpserts) {
      expect(u.value.type).toBe("npc");
    }
  });

  it("extracts characters from a realistic English narrative", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);
    const handler = contributions.runtimeHandlers.get("char-tracker")!;

    const narrative = [
      "The tavern was dimly lit, shadows dancing on the stone walls.",
      `"We should leave before dawn," Marcus whispered, glancing toward the door.`,
      `Lady Evelyn nodded, her expression grave. "The king's men will be here soon."`,
      `"Then we have no time to waste," Sir Gareth replied, rising from his seat.`,
      "You watched the three companions, weighing your options carefully.",
    ].join("\n");

    const ctx = createMockHandlerContext({
      contextOverrides: {
        narrative: { content: narrative, messageId: "msg_live_en" },
        run: {
          runId: "run_live",
          worldId: "world_live",
          branchId: "branch_main",
          turnId: "turn_live_002",
          status: "active",
          phase: "playing",
          defaultLocale: "en-US",
          activeBranchId: "branch_main",
        },
        locale: "en-US",
      },
      locale: "en-US",
    });

    const result = await handler(ctx);

    const upserts = findProposals<{ key: string; value: CharacterCard }>(
      result.proposals,
      "record.upsert"
    );
    const charUpserts = upserts.filter((u) => u.key.startsWith("character:"));
    const names = charUpserts.map((u) => u.value.name);

    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names).toContain("Marcus");
    expect(names).toContain("Lady Evelyn");
    expect(names).toContain("Sir Gareth");
  });
});
