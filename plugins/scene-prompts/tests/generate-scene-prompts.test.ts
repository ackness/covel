import { getPendingProposals, tool, z } from "@covel/tools";
import { describe, expect, it } from "vitest";
import createGenerateScenePrompts from "../tools/generate-scene-prompts.js";

describe("generate-scene-prompts", () => {
  const prompts = [
    { kind: "observe" as const, text: "我先观察破庙梁上的影子有没有呼吸声" },
    { kind: "ask" as const, text: "我低声问苏婉有没有认出这道符纹" },
    { kind: "act" as const, text: "我握紧短刀，绕到供桌侧面查看灰痕" },
  ];
  const context = {
    sessionId: "session-1",
    turnId: "turn-7",
    pluginId: "scene-prompts",
    runtimeId: "scene-prompts",
  };

  it("writes fixed-slot message data for the plugin-message UI", async () => {
    const scenePromptsTool = createGenerateScenePrompts({ tool, z });
    const result = await scenePromptsTool.execute(
      {
        scene: "破庙暗影",
        recap:
          "你和苏婉已经追踪符纹来到破庙，并约定先确认暗影身份再继续深入。梁上传来的动静让原定调查出现了新的风险。",
        decision: "你现在要先确认梁上暗影，还是继续检查供桌旁的符纹？",
        prompts,
      },
      context,
    );

    expect(result.scene).toBe("破庙暗影");
    expect(result.recap).toBe(
      "你和苏婉已经追踪符纹来到破庙，并约定先确认暗影身份再继续深入。梁上传来的动静让原定调查出现了新的风险。",
    );
    expect(result.decision).toBe(
      "你现在要先确认梁上暗影，还是继续检查供桌旁的符纹？",
    );
    expect(result.prompts).toHaveLength(3);

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    expect(proposal).toMatchObject({
      type: "plugin.data.batch",
      sessionId: "session-1",
      turnId: "turn-7",
      source: { pluginId: "scene-prompts", runtimeId: "scene-prompts" },
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
    const scenePromptsTool = createGenerateScenePrompts({ tool, z });
    const minimumResult = await scenePromptsTool.execute(
      {
        scene: "边界场景",
        recap: "前".repeat(20),
        decision: "问".repeat(8),
        prompts,
      },
      context,
    );
    const maximumResult = await scenePromptsTool.execute(
      {
        scene: "边界场景",
        recap: "前".repeat(240),
        decision: "问".repeat(120),
        prompts,
      },
      context,
    );

    expect(minimumResult.recap).toHaveLength(20);
    expect(minimumResult.decision).toHaveLength(8);
    expect(maximumResult.recap).toHaveLength(240);
    expect(maximumResult.decision).toHaveLength(120);
  });

  it("rejects recap and decision outside their documented boundaries", async () => {
    const scenePromptsTool = createGenerateScenePrompts({ tool, z });
    const baseParams = {
      scene: "边界场景",
      recap: "前".repeat(20),
      decision: "问".repeat(8),
      prompts,
    };

    await expect(
      scenePromptsTool.execute(
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
      scenePromptsTool.execute(
        {
          ...baseParams,
          recap: "长".repeat(241),
          decision: "长".repeat(121),
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
