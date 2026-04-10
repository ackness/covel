/**
 * guard.js — Pre-execution gate for schema-gen runtime.
 *
 * Runs before LLM is called. Checks whether world schema/entries already exist.
 * If found (from a previous session or imported from world.yaml), returns { skip: true }
 * to bypass the LLM call entirely.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function guard(ctx) {
  const { sessionId, store, pluginId } = ctx;
  const s = /** @type {any} */ (store);

  try {
    // Check if world schema already exists in plugin_data
    const existing = await s.listPluginData(sessionId, pluginId, 'schema');

    if (existing && existing.length > 0) {
      const entries = await s.listPluginData(sessionId, pluginId, 'entries');
      return {
        skip: true,
        initialized: true,
        schemaCount: existing.length,
        entryCount: entries?.length ?? 0,
        narrativeOutput: `[系统] 世界维度数据已加载（${existing.length} 个 schema, ${entries?.length ?? 0} 个词条）`,
      };
    }

    // Check if the world has pre-built dimensions in metadata
    const session = await s.getSession(sessionId);
    if (session?.worldId) {
      const world = await s.getWorld(session.worldId);
      const dimensions = /** @type {Record<string, unknown> | undefined} */ (
        world?.metadata?.dimensions
      );

      if (dimensions && Object.keys(dimensions).length > 0) {
        // Import dimensions from world.yaml into plugin_data (batch)
        const now = new Date().toISOString();
        const records = Object.entries(dimensions).map(([key, value]) => ({
          id: crypto.randomUUID(),
          sessionId,
          pluginId: pluginId,
          namespace: 'entries',
          key,
          value,
          createdAt: now,
          updatedAt: now,
        }));
        await s.setPluginDataBatch(records);

        // Entries imported but still need LLM to generate character attribute schema
        return {
          skip: false,
          initialized: true,
          importedDimensions: true,
          entryCount: records.length,
          narrativeOutput: `[系统] 从世界包导入了 ${records.length} 个维度词条`,
        };
      }
    }

    // Nothing found — LLM generation needed
    return { skip: false, initialized: false };
  } catch (err) {
    console.warn('[core-world-init] guard error:', err);
    return { skip: false, error: String(err) };
  }
}
