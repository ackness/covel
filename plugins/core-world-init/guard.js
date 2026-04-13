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
/**
 * Derive a character attribute schema from world dimensions.
 * Used when world.yaml has dimensions but no explicit schemas field —
 * avoids an LLM call by inferring sensible attributes from world data.
 *
 * @param {Record<string, unknown>} dimensions
 * @returns {Array<Record<string, unknown>>}
 */
function deriveSchema(dimensions) {
  /** @type {Array<Record<string, unknown>>} */
  const attrs = [
    { id: 'hp', name: '生命值', type: 'number', min: 0, max: 100, defaultValue: 100, category: 'stats', description: '当前生命值' },
    { id: 'stamina', name: '体力', type: 'number', min: 0, max: 100, defaultValue: 100, category: 'stats', description: '行动耐力' },
    { id: 'name', name: '姓名', type: 'string', category: 'bio', description: '角色名称' },
    { id: 'background', name: '背景', type: 'string', category: 'bio', description: '出身与经历' },
    { id: 'occupation', name: '职业', type: 'string', category: 'bio', description: '当前职业或身份' },
    { id: 'reputation', name: '声望', type: 'number', min: -100, max: 100, defaultValue: 0, category: 'social', description: '社会评价' },
    { id: 'skills', name: '技能', type: 'array', itemType: 'string', category: 'abilities', defaultValue: [], description: '掌握的技能列表' },
    { id: 'traits', name: '特征', type: 'array', itemType: 'string', category: 'abilities', defaultValue: [], description: '性格/身体特征' },
  ];

  // Add currency attribute from economy.currencies[0] if defined
  const economy = /** @type {any} */ (dimensions.economy);
  const firstCurrency = economy?.currencies?.[0];
  if (firstCurrency) {
    const currName = typeof firstCurrency.name === 'object'
      ? (firstCurrency.name['zh-CN'] ?? firstCurrency.name['en-US'] ?? '货币')
      : (firstCurrency.name ?? '货币');
    attrs.push({
      id: 'gold',
      name: currName,
      type: 'number',
      min: 0,
      defaultValue: 0,
      category: 'stats',
      description: `持有的${currName}数量`,
    });
  } else {
    attrs.push({ id: 'gold', name: '金币', type: 'number', min: 0, defaultValue: 0, category: 'stats' });
  }

  // Add power tier enum from powerSystem.tiers if defined
  const powerSystem = /** @type {any} */ (dimensions.powerSystem);
  if (Array.isArray(powerSystem?.tiers) && powerSystem.tiers.length > 0) {
    const tierOptions = powerSystem.tiers.map((/** @type {any} */ t) => {
      const n = t.name;
      return typeof n === 'object' ? (n['zh-CN'] ?? n['en-US'] ?? JSON.stringify(n)) : String(n ?? '');
    }).filter(Boolean);

    if (tierOptions.length > 0) {
      const psName = powerSystem.name;
      const attrName = typeof psName === 'object'
        ? (psName['zh-CN'] ?? psName['en-US'] ?? '境界')
        : (psName ?? '境界');
      attrs.push({
        id: 'powerTier',
        name: attrName,
        type: 'enum',
        options: tierOptions,
        defaultValue: tierOptions[0],
        category: 'abilities',
        description: `${attrName}等级`,
      });
    }
  }

  return attrs;
}

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

    // 3. Check if the world has pre-built dimensions in metadata.
    //    When dimensions exist, import entries + derive schema from world data,
    //    then skip the LLM entirely — no generation needed.
    if (worldId) {
      const world = await s.getWorld(worldId);
      const dimensions = /** @type {Record<string, unknown> | undefined} */ (
        world?.metadata?.dimensions
      );

      if (dimensions && Object.keys(dimensions).length > 0) {
        const now = new Date().toISOString();

        // Import all dimension keys as plugin_data entries
        const entryRecords = Object.entries(dimensions).map(([key, value]) => ({
          id: crypto.randomUUID(),
          sessionId,
          pluginId,
          namespace: 'entries',
          key,
          value,
          createdAt: now,
          updatedAt: now,
        }));
        await s.setPluginDataBatch(entryRecords);

        // Derive character attribute schema from world data (no LLM needed)
        const explicitSchemas = world?.metadata?.schemas;
        const attributes = Array.isArray(explicitSchemas) && explicitSchemas.length > 0
          ? explicitSchemas
          : deriveSchema(dimensions);

        await s.setPluginData({
          id: crypto.randomUUID(),
          sessionId,
          pluginId,
          namespace: 'schema',
          key: 'character-attributes',
          value: { version: 1, attributes },
          createdAt: now,
          updatedAt: now,
        });

        return {
          skip: true,
          initialized: true,
          importedDimensions: true,
          entryCount: entryRecords.length,
          schemaCount: attributes.length,
          narrativeOutput: `[系统] 从世界包全量导入：${entryRecords.length} 个维度词条，${attributes.length} 个角色属性`,
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
