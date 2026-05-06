/**
 * @covel/plugin-{{pluginName}} — echo handler
 *
 * 玩家点击侧栏 "Echo Hello" 按钮 → 框架以 manual trigger 调起本 handler。
 * 唯一副作用：向本插件的 `messages` namespace 追加一条 "hello"。
 * UI 面板订阅同一 namespace 的 plugin-data.changed SSE，自动重渲染。
 */

const MESSAGES_NAMESPACE = "messages";

export default async function echoHandler(ctx) {
	const { pluginData, logger, turnId } = ctx;

	if (!pluginData || typeof pluginData.set !== "function") {
		return {
			status: "failed",
			error: "ctx.pluginData.set is unavailable. Upgrade @covel/runtime.",
		};
	}

	const id = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const record = {
		id,
		role: "echo",
		text: "hello",
		turnId,
		createdAt: new Date().toISOString(),
	};

	await pluginData.set(MESSAGES_NAMESPACE, id, record);
	await logger?.info?.("echo.appended", { id });

	return { status: "ok", message: record };
}
