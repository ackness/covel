import { describe, it, expect } from "vitest";
import {
  LIVE,
  createLiveGenerateText,
  createMockHandlerContext,
  createCollectingRegistrar,
  findProposal,
  assertProposalContains,
} from "@covel/plugin-test-utils";
import { buildSummaryPrompt, parseSummaryResponse } from "../server/logic.js";
import type { MemoryArchive } from "../server/logic.js";
import register from "../server/index.js";

describe.skipIf(!LIVE)("live: core-memory", () => {
  it("generates a coherent Chinese summary via LLM", async () => {
    const generateText = await createLiveGenerateText();

    const prompt = buildSummaryPrompt(
      "勇者艾伦在黑暗森林深处发现了一把散发着蓝光的古剑。森林中的精灵族长老告诉他，这把剑名为「星辉」，是千年前封印魔王的神器。艾伦决定带着星辉前往北方的冰霜要塞，寻找解除封印的方法。途中，他遇到了流浪法师莉娜，她自称能读懂古代符文。",
      undefined,
      [
        { type: "item.acquired", payload: "获得古剑「星辉」" },
        { type: "npc.met", payload: "遇到流浪法师莉娜" },
      ],
      "zh-CN"
    );

    const response = await generateText(prompt);
    const parsed = parseSummaryResponse(response);

    expect(parsed.summary.length).toBeGreaterThan(50);
    // Summary should mention key characters
    expect(parsed.summary).toMatch(/艾伦|勇者/);
    // Should mention the sword
    expect(parsed.summary).toMatch(/星辉|古剑|剑/);
  }, 60_000);

  it("generates a coherent English summary via LLM", async () => {
    const generateText = await createLiveGenerateText();

    const prompt = buildSummaryPrompt(
      "The brave warrior Allen discovered an ancient sword glowing with blue light deep in the Dark Forest. The elder of the forest elves told him the sword was called Starblade, a divine artifact used to seal the Demon King a thousand years ago. Allen decided to travel north to the Frost Fortress to find a way to break the seal. Along the way, he met a wandering mage named Lina, who claimed she could read ancient runes.",
      "Previously, Allen left his home village after mysterious tremors destroyed the town square.",
      [
        { type: "item.acquired", payload: "Obtained the ancient sword Starblade" },
        { type: "npc.met", payload: "Met wandering mage Lina" },
      ],
      "en-US"
    );

    const response = await generateText(prompt);
    const parsed = parseSummaryResponse(response);

    expect(parsed.summary.length).toBeGreaterThan(50);
    expect(parsed.summary).toMatch(/Allen|warrior|hero/i);
    expect(parsed.summary).toMatch(/Starblade|sword/i);
    // Should incorporate previous summary info
    expect(parsed.summary).toMatch(/village|home|tremor/i);
  }, 60_000);

  it("runs full handler with live LLM and produces valid proposals", async () => {
    const generateText = await createLiveGenerateText();

    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("memory-summarizer")!;

    const ctx = createMockHandlerContext({
      contextOverrides: {
        narrative: {
          content:
            "勇者艾伦在森林中遭遇了暗影狼群的袭击。经过激烈战斗，莉娜用火焰魔法击退了狼群。艾伦的手臂在战斗中受伤，莉娜用治愈术为他疗伤。两人在篝火旁休息，莉娜透露她其实是被流放的宫廷法师。",
          messageId: "msg_050",
        },
        state: {
          memoryArchive: {
            summary:
              "勇者艾伦在黑暗森林发现了古剑「星辉」，并遇到了流浪法师莉娜。他们决定前往北方的冰霜要塞。",
            version: 1,
            lastTurnId: "turn_005",
          },
        },
        events: [{ type: "combat.resolved" as unknown as undefined }],
        run: {
          runId: "run_live",
          worldId: "world_live",
          branchId: "branch_main",
          turnId: "turn_010",
          status: "active",
          phase: "playing",
          defaultLocale: "zh-CN",
          activeBranchId: "branch_main",
        },
      },
      generateTextImpl: generateText,
    });

    const result = await handler(ctx);

    assertProposalContains(result.proposals, ["state.patch"]);

    const patch = findProposal<{ memoryArchive: MemoryArchive }>(
      result.proposals,
      "state.patch"
    );
    expect(patch).toBeDefined();
    expect(patch!.memoryArchive.version).toBe(2);
    expect(patch!.memoryArchive.summary.length).toBeGreaterThan(30);
    expect(patch!.memoryArchive.lastTurnId).toBe("turn_010");
  }, 60_000);
});
