/**
 * set-world-entries-batch — Batch-write world entries (geography, factions, etc.).
 * Single call to create all entries, avoiding N separate tool calls.
 *
 * @param {{ tool: Function, z: import('zod'), store: any }} injection
 */
export default function ({ tool, z, store }) {
  return tool({
    name: 'set-world-entries-batch',
    description: '批量写入世界词条。一次调用传入所有词条（地理、阵营、货币、力量体系等），无需逐个调用。至少 5 个词条。',
    parameters: z.object({
      entries: z.array(z.object({
        key: z.string().min(1).describe('词条标识（如 "geography", "factions", "currency"）'),
        value: z.record(z.unknown()).describe('词条内容（任意 JSON 对象）'),
      })).min(1).describe('世界词条数组'),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();
      const records = params.entries.map((entry) => ({
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        pluginId: context.pluginId,
        namespace: 'entries',
        key: entry.key,
        value: entry.value,
        createdAt: now,
        updatedAt: now,
      }));
      await store.setPluginDataBatch(records);
      return {
        success: true,
        count: records.length,
        keys: params.entries.map((e) => e.key),
      };
    },
  });
}
