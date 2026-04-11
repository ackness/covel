/**
 * guard.js — Pre-execution gate for schema-gen runtime.
 *
 * Runs before LLM is called. Checks whether world schema/entries already exist.
 * If found (from current session, a previous session of the same world, or
 * imported from world.yaml), returns { skip: true } to bypass the LLM call.
 *
 * Cross-session reuse: when a new session is created for the same world,
 * the guard copies schema + entries from a previous session instead of
 * regenerating via LLM (~30s saved).
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function guard(ctx) {
  const { sessionId, store, pluginId } = ctx;
  const s = /** @type {any} */ (store);

  try {
    // 1. Check current session's plugin_data
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

    // 2. Check previous sessions of the same world for reusable data
    const session = await s.getSession(sessionId);
    const worldId = session?.worldId;

    if (worldId) {
      const allSessions = await s.listSessions();
      const previousSessions = allSessions.filter(
        (/** @type {any} */ ss) => ss.worldId === worldId && ss.id !== sessionId,
      );

      for (const prev of previousSessions) {
        const prevSchema = await s.listPluginData(prev.id, pluginId, 'schema');
        if (prevSchema && prevSchema.length > 0) {
          const prevEntries = await s.listPluginData(prev.id, pluginId, 'entries');

          // Copy schema + entries to current session
          const now = new Date().toISOString();
          const records = [
            ...prevSchema.map((/** @type {any} */ r) => ({
              id: crypto.randomUUID(),
              sessionId,
              pluginId,
              namespace: r.namespace,
              key: r.key,
              value: r.value,
              createdAt: now,
              updatedAt: now,
            })),
            ...(prevEntries ?? []).map((/** @type {any} */ r) => ({
              id: crypto.randomUUID(),
              sessionId,
              pluginId,
              namespace: r.namespace,
              key: r.key,
              value: r.value,
              createdAt: now,
              updatedAt: now,
            })),
          ];

          if (records.length > 0) {
            await s.setPluginDataBatch(records);
          }

          return {
            skip: true,
            initialized: true,
            reusedFrom: prev.id,
            schemaCount: prevSchema.length,
            entryCount: prevEntries?.length ?? 0,
            narrativeOutput: `[系统] 从历史会话复用世界维度数据（${prevSchema.length} 个 schema, ${prevEntries?.length ?? 0} 个词条）`,
          };
        }
      }
    }

    // 3. Check if the world has pre-built dimensions in metadata
    if (worldId) {
      const world = await s.getWorld(worldId);
      const dimensions = /** @type {Record<string, unknown> | undefined} */ (
        world?.metadata?.dimensions
      );

      if (dimensions && Object.keys(dimensions).length > 0) {
        // Import dimensions from world.yaml into plugin_data
        const now = new Date().toISOString();
        const records = Object.entries(dimensions).map(([key, value]) => ({
          id: crypto.randomUUID(),
          sessionId,
          pluginId,
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

    // 4. Nothing found — LLM generation needed
    return { skip: false, initialized: false };
  } catch (err) {
    console.warn('[core-world-init] guard error:', err);
    return { skip: false, error: String(err) };
  }
}
