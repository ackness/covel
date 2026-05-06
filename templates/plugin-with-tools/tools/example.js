/**
 * Plugin-local tool: example-action
 *
 * 示例工具 —— 创建新插件时请根据实际需求修改。
 * 框架注入 tool、z、store，无需 import 任何依赖。
 */

export default function ({ tool, z, store }) {
	return tool({
		name: "example-action",
		description: "示例工具：记录一个事件。请根据实际需求修改此工具。",
		parameters: z.object({
			subject: z.string().min(1).describe("事件主体"),
			description: z.string().min(1).describe("事件描述"),
		}),
		execute: async (params, context) => {
			const key = `event-${Date.now()}`;
			const value = {
				subject: params.subject,
				description: params.description,
				turn: context.turnId,
			};

			await store.setPluginData({
				sessionId: context.sessionId,
				pluginId: context.pluginId,
				namespace: "events",
				key,
				value,
			});

			return { recorded: true, key };
		},
	});
}
