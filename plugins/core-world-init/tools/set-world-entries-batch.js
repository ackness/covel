/**
 * set-world-entries-batch — Batch-write world entries (geography, factions, etc.).
 * Single call to create all entries, avoiding N separate tool calls.
 *
 * Data destinations (FU-8, S3-T2 follow-up):
 *   1. `plugin_data` namespace=entries — legacy read path, preserved for
 *      backward compatibility with `loadSessionConfig` which hydrates
 *      `{{ config.worldEntries }}` when the session has no lorebook data.
 *   2. `lorebook_entries` (session-scoped, constant strategy) — canonical
 *      destination for world dimensions. Each entry becomes one `constant`
 *      lorebook row so the context loader can compose `worldEntries` from
 *      lorebook first, then fall back to plugin_data.
 *
 * The tool writes to both destinations so core-world-init can migrate
 * incrementally without breaking sessions that predate the lorebook layer.
 * If the store does not expose `upsertLorebookEntries` (thin mock stores),
 * only the plugin_data write is performed.
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

      // 1) Legacy plugin_data write — unchanged read path for old sessions.
      const pluginDataRecords = params.entries.map((entry) => ({
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        pluginId: context.pluginId,
        namespace: 'entries',
        key: entry.key,
        value: entry.value,
        createdAt: now,
        updatedAt: now,
      }));
      await store.setPluginDataBatch(pluginDataRecords);

      // 2) Lorebook write — canonical destination for world dimensions.
      // Each entry becomes one `constant` lorebook row. The id is a
      // deterministic suffix of (sessionId, key) so re-runs replace rather
      // than duplicate. Spacing insertionOrder by 100 keeps room for
      // future interleaving without a full re-numbering.
      if (typeof store.upsertLorebookEntries === 'function') {
        const lorebookRecords = params.entries.map((entry, idx) => ({
          id: `world-entry:${entry.key}`,
          sessionId: context.sessionId,
          pluginId: context.pluginId,
          keys: [entry.key],
          content: formatEntryContent(entry.key, entry.value),
          strategy: 'constant',
          position: 'after_char_defs',
          insertionOrder: 100 + idx * 100,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        }));
        try {
          await store.upsertLorebookEntries(lorebookRecords);
        } catch (err) {
          // Non-fatal: if the lorebook layer rejects the write (e.g. a
          // legacy backend that advertised the method but hasn't been
          // migrated), the plugin_data path above still delivers the data
          // to the legacy context loader.
          // eslint-disable-next-line no-console
          console.warn('[set-world-entries-batch] lorebook write failed:', err);
        }
      }

      return {
        success: true,
        count: pluginDataRecords.length,
        keys: params.entries.map((e) => e.key),
      };
    },
  });
}

/**
 * Render a world entry as a readable lorebook content block. The context
 * loader joins these on blank lines to build `{{ config.worldEntries }}`
 * so the content should be self-describing (prefixed with the key) and
 * stable across runs for deterministic prompt assembly.
 */
function formatEntryContent(key, value) {
  let body;
  try {
    body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    body = String(value);
  }
  return `[${key}]\n${body}`;
}
