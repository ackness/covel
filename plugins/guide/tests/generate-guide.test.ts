import {
  getToolContent,
  getPendingProposals,
} from "@covel/plugin-handlers-utils";

import { tool, z } from "@covel/tools";
import { describe, expect, it } from "vitest";
import createGenerateGuide from "../tools/generate-guide.js";

describe("generate-guide", () => {
  const prompts = [
    { kind: "observe" as const, text: "我先观察破庙梁上的影子有没有呼吸声" },
    { kind: "ask" as const, text: "我低声问苏婉有没有认出这道符纹" },
    { kind: "act" as const, text: "我握紧短刀，绕到供桌侧面查看灰痕" },
  ];
  const context = {
    sessionId: "session-1",
    turnId: "turn-7",
    pluginId: "guide",
    runtimeId: "guide",
  };

  it("writes fixed-slot message data for the plugin-message UI", async () => {
    const guideTool = createGenerateGuide({ tool, z });
    const result = await guideTool.execute(
      {
        scene: "破庙暗影",
        recap:
          "你和苏婉已经追踪符纹来到破庙，并约定先确认暗影身份再继续深入。梁上传来的动静让原定调查出现了新的风险。",
        decision: "你现在要先确认梁上暗影，还是继续检查供桌旁的符纹？",
        prompts,
      },
      context,
    );

    expect(getToolContent(result).scene).toBe("破庙暗影");
    expect(getToolContent(result).recap).toBe(
      "你和苏婉已经追踪符纹来到破庙，并约定先确认暗影身份再继续深入。梁上传来的动静让原定调查出现了新的风险。",
    );
    expect(getToolContent(result).decision).toBe(
      "你现在要先确认梁上暗影，还是继续检查供桌旁的符纹？",
    );
    expect(getToolContent(result).prompts).toHaveLength(3);

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    expect(proposal).toMatchObject({
      type: "plugin.data.batch",
      sessionId: "session-1",
      turnId: "turn-7",
      source: { pluginId: "guide", runtimeId: "guide" },
    });

    const items = proposal.payload.items as Array<{
      namespace: string;
      key: string;
      value: unknown;
    }>;
    expect(items).toContainEqual({
      namespace: "message",
      key: "__turnId",
      value: "turn-7",
    });
    expect(items).toContainEqual({
      namespace: "message",
      key: "scene",
      value: "破庙暗影",
    });
    expect(items).toContainEqual({
      namespace: "message",
      key: "recap",
      value:
        "你和苏婉已经追踪符纹来到破庙，并约定先确认暗影身份再继续深入。梁上传来的动静让原定调查出现了新的风险。",
    });
    expect(items).toContainEqual({
      namespace: "message",
      key: "decision",
      value: "你现在要先确认梁上暗影，还是继续检查供桌旁的符纹？",
    });
    expect(items).toContainEqual({
      namespace: "message",
      key: "prompt2Text",
      value: "我低声问苏婉有没有认出这道符纹",
    });
    expect(items).toContainEqual({
      namespace: "message",
      key: "prompt3Icon",
      value: "zap",
    });
    expect(items).toContainEqual({
      namespace: "message",
      key: "prompt6Text",
      value: "",
    });
  });

  it("accepts recap and decision at their documented length boundaries", async () => {
    const guideTool = createGenerateGuide({ tool, z });
    const minimumResult = await guideTool.execute(
      {
        scene: "边界场景",
        recap: "前".repeat(20),
        decision: "问".repeat(8),
        prompts,
      },
      context,
    );
    const maximumResult = await guideTool.execute(
      {
        scene: "边界场景",
        recap: "前".repeat(600),
        decision: "问".repeat(300),
        prompts,
      },
      context,
    );
    // The bounds are sized for every language: a three-sentence English
    // recap is about twice as long in characters as the same in Chinese.
    const english = await guideTool.execute(
      {
        scene: "The Flooded Stair",
        recap:
          "You followed Su Yao down the ferry stair after the third bell. The rope at the iron post was cut within the hour, and black tide-salt marks the same edge as Qi's letter. You promised the clerk that you would report back before the curfew horn.",
        decision:
          "Do you go down to the dry riverbed now, or report to the clerk first as you promised?",
        prompts: [
          {
            kind: "observe",
            text: "I study the cut end of the rope before touching anything else.",
          },
          {
            kind: "ask",
            text: "I ask Su Yao who had the watch here an hour ago.",
          },
          {
            kind: "act",
            text: "I go down the stair, lamp shuttered, one step at a time.",
          },
        ],
      },
      context,
    );
    expect(getToolContent(english).recap.length).toBeGreaterThan(240);

    expect(getToolContent(minimumResult).recap).toHaveLength(20);
    expect(getToolContent(minimumResult).decision).toHaveLength(8);
    expect(getToolContent(maximumResult).recap).toHaveLength(600);
    expect(getToolContent(maximumResult).decision).toHaveLength(300);
  });

  it("rejects recap and decision outside their documented boundaries", async () => {
    const guideTool = createGenerateGuide({ tool, z });
    const baseParams = {
      scene: "边界场景",
      recap: "前".repeat(20),
      decision: "问".repeat(8),
      prompts,
    };

    await expect(
      guideTool.execute(
        { ...baseParams, recap: "短".repeat(19), decision: "短".repeat(7) },
        context,
      ),
    ).rejects.toMatchObject({
      name: "ToolValidationError",
      details: expect.arrayContaining([
        expect.objectContaining({ path: "recap" }),
        expect.objectContaining({ path: "decision" }),
      ]),
    });

    await expect(
      guideTool.execute(
        {
          ...baseParams,
          recap: "长".repeat(601),
          decision: "长".repeat(301),
        },
        context,
      ),
    ).rejects.toMatchObject({
      name: "ToolValidationError",
      details: expect.arrayContaining([
        expect.objectContaining({ path: "recap" }),
        expect.objectContaining({ path: "decision" }),
      ]),
    });
  });
});
