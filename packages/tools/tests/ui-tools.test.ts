import { describe, expect, it } from "vitest";
import { renderUITool } from "../src/index.js";

describe("builtin ui tools", () => {
	it("render-ui returns typed ui parts with independent status", async () => {
		const result = await renderUITool.execute(
			{
				layout: "stream",
				parts: [
					{ id: "p1", type: "text", status: "streaming", content: "hello" },
					{
						id: "p2",
						type: "image",
						status: "pending",
						content: { prompt: "forest" },
					},
				],
			},
			{
				sessionId: "sess-1",
				turnId: "turn-1",
				pluginId: "plugin",
				runtimeId: "runtime",
			},
		);

		expect(result).toEqual({
			rendered: true,
			ui: [
				{
					layout: "stream",
					parts: [
						{ id: "p1", type: "text", status: "streaming", content: "hello" },
						{
							id: "p2",
							type: "image",
							status: "pending",
							content: { prompt: "forest" },
						},
					],
				},
			],
		});
	});
});
