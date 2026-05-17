/**
 * Plugin-local tool: record-note
 *
 * Persists one plugin-owned note through the proposal pipeline. The framework
 * injects tool, z, shortId, and withPendingProposals; no dependency import is
 * required here.
 */

export default function ({ tool, z, shortId, withPendingProposals }) {
  return tool({
    name: "record-note",
    description:
      "记录一条和本插件目标相关的结构化笔记。只在叙事中出现可复用的新信息时调用。",
    parameters: z.object({
      title: z.string().min(1).max(80).describe("短标题"),
      text: z.string().min(1).max(500).describe("一到两句具体记录"),
      tags: z.array(z.string().min(1)).max(5).default([]).describe("分类标签"),
    }),
    execute: async (params, context) => {
      const key = shortId("note", params.title, context.sessionId);
      const now = new Date().toISOString();
      const note = {
        kind: "note",
        title: params.title,
        text: params.text,
        tags: params.tags,
        turnId: context.turnId,
        createdAt: now,
      };

      return withPendingProposals({ recorded: true, key, note }, [
        {
          id: crypto.randomUUID(),
          type: "plugin.data",
          source: {
            pluginId: context.pluginId,
            runtimeId: context.runtimeId,
          },
          turnId: context.turnId,
          sessionId: context.sessionId,
          payload: {
            namespace: "notes",
            key,
            value: note,
          },
          timestamp: now,
        },
      ]);
    },
  });
}
