import { getPendingProposals, tool, z } from "@covel/tools";
import { describe, expect, it } from "vitest";
import createGenerateScenePrompts from "../tools/generate-scene-prompts.js";

describe("generate-scene-prompts", () => {
	it("writes fixed-slot message data for the plugin-message UI", async () => {
		const scenePromptsTool = createGenerateScenePrompts({ tool, z });
		const result = await scenePromptsTool.execute(
			{
				scene: "破庙暗影",
				prompts: [
					{ kind: "observe", text: "我先观察破庙梁上的影子有没有呼吸声" },
					{ kind: "ask", text: "我低声问苏婉有没有认出这道符纹" },
					{ kind: "act", text: "我握紧短刀，绕到供桌侧面查看灰痕" },
				],
			},
			{
				sessionId: "session-1",
				turnId: "turn-7",
				pluginId: "scene-prompts",
				runtimeId: "scene-prompts",
			},
		);

		expect(result.scene).toBe("破庙暗影");
		expect(result.prompts).toHaveLength(3);

		const [proposal] = getPendingProposals(result);
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
});
