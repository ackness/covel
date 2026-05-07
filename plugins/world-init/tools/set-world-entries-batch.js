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
 * The tool emits both writes as pending proposals so the kernel commits them
 * through the same transaction path as every other runtime side effect.
 *
 * @param {{ tool: Function, z: import('zod'), store: any }} injection
 */
import { withPendingProposals } from "@covel/tools";

export default function ({ tool, z, store }) {
  void store;
  return tool({
    name: "set-world-entries-batch",
    description:
      "批量写入世界词条。一次调用传入所有词条（地理、阵营、货币、力量体系等），无需逐个调用。至少 5 个词条。",
    parameters: z.object({
      entries: z
        .array(
          z.object({
            key: z
              .string()
              .min(1)
              .describe('词条标识（如 "geography", "factions", "currency"）'),
            value: z
              .record(z.string(), z.unknown())
              .describe("词条内容（任意 JSON 对象）"),
          }),
        )
        .min(1)
        .describe("世界词条数组"),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();

      // 1) Legacy plugin_data write — unchanged read path for old sessions.
      const pluginDataRecords = params.entries.map((entry) => ({
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        pluginId: context.pluginId,
        namespace: "entries",
        key: entry.key,
        value: entry.value,
        createdAt: now,
        updatedAt: now,
      }));

      // 2) Lorebook proposal — canonical destination for world dimensions.
      // Each entry becomes one `constant` lorebook row. The id is a
      // deterministic suffix of (sessionId, key) so re-runs replace rather
      // than duplicate. Spacing insertionOrder by 100 keeps room for
      // future interleaving without a full re-numbering.
      const lorebookEntries = params.entries.map((entry, idx) => ({
        id: `world-entry:${entry.key}`,
        keys: [entry.key],
        content: formatEntryContent(entry.key, entry.value),
        strategy: "constant",
        position: "after_char_defs",
        insertionOrder: 100 + idx * 100,
        enabled: true,
      }));

      return withPendingProposals(
        {
          success: true,
          count: pluginDataRecords.length,
          keys: params.entries.map((e) => e.key),
        },
        [
          {
            id: crypto.randomUUID(),
            type: "plugin.data.batch",
            source: {
              pluginId: context.pluginId,
              runtimeId: context.runtimeId,
            },
            turnId: context.turnId,
            sessionId: context.sessionId,
            payload: {
              items: pluginDataRecords.map((record) => ({
                namespace: record.namespace,
                key: record.key,
                value: record.value,
              })),
            },
            timestamp: now,
          },
          {
            id: crypto.randomUUID(),
            type: "lorebook.upsert",
            source: {
              pluginId: context.pluginId,
              runtimeId: context.runtimeId,
            },
            turnId: context.turnId,
            sessionId: context.sessionId,
            payload: {
              entries: lorebookEntries,
            },
            timestamp: now,
          },
        ],
      );
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
    body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    body = String(value);
  }
  return `[${key}]\n${body}`;
}
