import { withPendingProposals } from "@covel/tools";

const KIND_CONFIG = {
	observe: { label: "观察", icon: "eye", color: "blue" },
	ask: { label: "追问", icon: "lightbulb", color: "purple" },
	act: { label: "行动", icon: "zap", color: "green" },
	social: { label: "交涉", icon: "user", color: "amber" },
};

function makePluginDataBatchProposal(context, items, timestamp) {
	return {
		id: crypto.randomUUID(),
		type: "plugin.data.batch",
		source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
		turnId: context.turnId,
		sessionId: context.sessionId,
		payload: { items },
		timestamp,
	};
}

export default function ({ tool, z }) {
	const promptSchema = z.object({
		kind: z
			.enum(["observe", "ask", "act", "social"])
			.describe("提示类型：observe/ask/act/social"),
		text: z
			.string()
			.min(1)
			.max(80)
			.describe("玩家可以直接发送的场景化行动短句"),
	});

	return tool({
		name: "generate-scene-prompts",
		description:
			"生成场景化快捷回复。写入 message 命名空间，前端以 ui.message 渲染为可草拟或直接发送的提示按钮。",
		parameters: z.object({
			scene: z.string().min(1).max(40).describe("当前场景或决策点标题"),
			prompts: z
				.array(promptSchema)
				.min(3)
				.max(6)
				.describe("3-6 条可直接发送的玩家行动短句"),
		}),
		execute: async (params, context) => {
			const now = new Date().toISOString();
			const prompts = params.prompts.slice(0, 6).map((prompt) => {
				const config = KIND_CONFIG[prompt.kind];
				return {
					kind: prompt.kind,
					label: config.label,
					icon: config.icon,
					color: config.color,
					text: prompt.text,
				};
			});

			const items = [
				{ namespace: "message", key: "__turnId", value: context.turnId },
				{ namespace: "message", key: "scene", value: params.scene },
			];

			for (let i = 0; i < 6; i += 1) {
				const slot = i + 1;
				const prompt = prompts[i];
				items.push(
					{
						namespace: "message",
						key: `prompt${slot}Text`,
						value: prompt?.text ?? "",
					},
					{
						namespace: "message",
						key: `prompt${slot}Kind`,
						value: prompt?.kind ?? "",
					},
					{
						namespace: "message",
						key: `prompt${slot}Label`,
						value: prompt?.label ?? "",
					},
					{
						namespace: "message",
						key: `prompt${slot}Icon`,
						value: prompt?.icon ?? "",
					},
					{
						namespace: "message",
						key: `prompt${slot}Color`,
						value: prompt?.color ?? "",
					},
				);
			}

			return withPendingProposals(
				{
					scene: params.scene,
					prompts,
				},
				[makePluginDataBatchProposal(context, items, now)],
			);
		},
	});
}
