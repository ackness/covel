import { pickLocaleText as pick } from "@covel/plugin-handlers-utils";

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
  // Attribute name/description are I18nText ({ "zh-CN", "en-US" }) so the
  // display layer resolves them per session locale (character-schema.ts types
  // them as I18nText). Worlds with declared characterAttributes override this.
  const attrs = [
    {
      id: "hp",
      name: { "zh-CN": "生命值", "en-US": "Health" },
      type: "number",
      min: 0,
      max: 100,
      defaultValue: 100,
      category: "stats",
      description: { "zh-CN": "当前生命值", "en-US": "Current health" },
    },
    {
      id: "stamina",
      name: { "zh-CN": "体力", "en-US": "Stamina" },
      type: "number",
      min: 0,
      max: 100,
      defaultValue: 100,
      category: "stats",
      description: { "zh-CN": "行动耐力", "en-US": "Action endurance" },
    },
    {
      id: "name",
      name: { "zh-CN": "姓名", "en-US": "Name" },
      type: "string",
      category: "bio",
      description: { "zh-CN": "角色名称", "en-US": "Character name" },
    },
    {
      id: "background",
      name: { "zh-CN": "背景", "en-US": "Background" },
      type: "string",
      category: "bio",
      description: { "zh-CN": "出身与经历", "en-US": "Origin and history" },
    },
    {
      id: "occupation",
      name: { "zh-CN": "职业", "en-US": "Occupation" },
      type: "string",
      category: "bio",
      description: {
        "zh-CN": "当前职业或身份",
        "en-US": "Current occupation or identity",
      },
    },
    {
      id: "reputation",
      name: { "zh-CN": "声望", "en-US": "Reputation" },
      type: "number",
      min: -100,
      max: 100,
      defaultValue: 0,
      category: "social",
      description: { "zh-CN": "社会评价", "en-US": "Social standing" },
    },
    {
      id: "skills",
      name: { "zh-CN": "技能", "en-US": "Skills" },
      type: "array",
      itemType: "string",
      category: "abilities",
      defaultValue: [],
      description: {
        "zh-CN": "掌握的技能列表",
        "en-US": "List of learned skills",
      },
    },
    {
      id: "traits",
      name: { "zh-CN": "特征", "en-US": "Traits" },
      type: "array",
      itemType: "string",
      category: "abilities",
      defaultValue: [],
      description: {
        "zh-CN": "性格/身体特征",
        "en-US": "Personality and physical traits",
      },
    },
  ];

  // Add currency attribute from economy.currencies[0] if defined
  const economy = /** @type {any} */ (dimensions.economy);
  const firstCurrency = economy?.currencies?.[0];
  if (firstCurrency) {
    const currName =
      typeof firstCurrency.name === "object"
        ? (firstCurrency.name["zh-CN"] ?? firstCurrency.name["en-US"] ?? "货币")
        : (firstCurrency.name ?? "货币");
    attrs.push({
      id: "gold",
      name: currName,
      type: "number",
      min: 0,
      defaultValue: 0,
      category: "stats",
      description: `持有的${currName}数量`,
    });
  } else {
    attrs.push({
      id: "gold",
      name: { "zh-CN": "金币", "en-US": "Gold" },
      type: "number",
      min: 0,
      defaultValue: 0,
      category: "stats",
    });
  }

  // Add power tier enum from powerSystem.tiers if defined
  const powerSystem = /** @type {any} */ (dimensions.powerSystem);
  if (Array.isArray(powerSystem?.tiers) && powerSystem.tiers.length > 0) {
    const tierOptions = powerSystem.tiers
      .map((/** @type {any} */ t) => {
        const n = t.name;
        return typeof n === "object"
          ? (n["zh-CN"] ?? n["en-US"] ?? JSON.stringify(n))
          : String(n ?? "");
      })
      .filter(Boolean);

    if (tierOptions.length > 0) {
      const psName = powerSystem.name;
      const attrName =
        typeof psName === "object"
          ? (psName["zh-CN"] ?? psName["en-US"] ?? "境界")
          : (psName ?? "境界");
      attrs.push({
        id: "powerTier",
        name: attrName,
        type: "enum",
        options: tierOptions,
        defaultValue: tierOptions[0],
        category: "abilities",
        description: `${attrName}等级`,
      });
    }
  }

  return attrs;
}

export default async function guard(ctx) {
  const { sessionId, store, pluginId, locale } = ctx;
  const s = /** @type {any} */ (store);

  try {
    // 1. Check current session's plugin_data
    const existing = await s.listPluginData(sessionId, pluginId, "schema");

    if (existing && existing.length > 0) {
      const entries = await s.listPluginData(sessionId, pluginId, "entries");
      if ((entries?.length ?? 0) > 0) {
        return {
          skip: true,
          initialized: true,
          schemaCount: existing.length,
          entryCount: entries?.length ?? 0,
          narrativeOutput: pick(
            locale,
            `[系统] 世界维度数据已加载（${existing.length} 个 schema, ${entries?.length ?? 0} 个词条）`,
            `[System] World dimension data loaded (${existing.length} schema, ${entries?.length ?? 0} entries)`,
          ),
          preGameDone: true,
        };
      }
    }

    // Resolve the world once for the remaining paths.
    const session = await s.getSession(sessionId);
    const worldId = session?.worldId;
    const world = worldId ? await s.getWorld(worldId) : undefined;

    // 2a. A world that DECLARES character attributes is authoritative: write
    //     them verbatim (+ import dimension entries) and skip — even when an
    //     older session of this world exists, whose schema may predate the
    //     declaration. No LLM, and no cross-session reuse of a stale schema, so
    //     editing `world.yaml characterAttributes` takes effect on new sessions.
    const declaredAttributes =
      world?.metadata?.characterAttributes ?? world?.metadata?.schemas;
    if (Array.isArray(declaredAttributes) && declaredAttributes.length > 0) {
      const now = new Date().toISOString();
      const dimensions = /** @type {Record<string, unknown> | undefined} */ (
        world?.metadata?.dimensions
      );
      const entryRecords =
        dimensions && Object.keys(dimensions).length > 0
          ? Object.entries(dimensions).map(([key, value]) => ({
              id: crypto.randomUUID(),
              sessionId,
              pluginId,
              namespace: "entries",
              key,
              value,
              createdAt: now,
              updatedAt: now,
            }))
          : [];
      if (entryRecords.length > 0) {
        await s.setPluginDataBatch(entryRecords);
      }
      await s.setPluginData({
        id: crypto.randomUUID(),
        sessionId,
        pluginId,
        namespace: "schema",
        key: "character-attributes",
        value: { version: 1, attributes: declaredAttributes },
        createdAt: now,
        updatedAt: now,
      });
      return {
        skip: true,
        initialized: true,
        importedDimensions: entryRecords.length > 0,
        entryCount: entryRecords.length,
        schemaCount: declaredAttributes.length,
        narrativeOutput: pick(
          locale,
          `[系统] 从世界包导入角色属性 Schema（${declaredAttributes.length} 个属性${entryRecords.length ? `，${entryRecords.length} 个维度词条` : ""}）`,
          `[System] Imported character attribute schema from world package (${declaredAttributes.length} attributes${entryRecords.length ? `, ${entryRecords.length} dimension entries` : ""})`,
        ),
        preGameDone: true,
      };
    }

    // NOTE: there used to be a step 2b here that scanned every OTHER session
    // of the same world, picked whichever had the most plugin-data rows, and
    // copied its whole `schema` + `entries` namespaces into this session. It
    // was a cache for worlds that declare neither character attributes nor
    // dimensions (step 3 / the LLM path below), saving one schema-gen call.
    //
    // It is gone because session plugin-data is not a trustworthy source: the
    // generic `PUT /plugin-data` route lets a session owner write any active
    // plugin's namespace, so the "best" source session could carry
    // player-authored values — and on hosted tiers those sessions can belong
    // to a different user entirely, making this a cross-user read. Copying it
    // in would both leak and poison. Worlds that declare attributes (2a) or
    // ship dimensions (3) never reached this branch anyway; the only cost is
    // one schema-gen call per session on a world that supplies neither.

    // 3. World has pre-built dimensions but no declared attributes: import
    //    entries + derive a generic schema from world data, then skip the LLM.
    //    (The declared-attributes case is handled authoritatively in 2a above.)
    if (worldId && world) {
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
          namespace: "entries",
          key,
          value,
          createdAt: now,
          updatedAt: now,
        }));
        await s.setPluginDataBatch(entryRecords);

        // No declared attributes (2a would have returned) — infer generic
        // attributes from world data so no LLM call is needed.
        const attributes = deriveSchema(dimensions);

        await s.setPluginData({
          id: crypto.randomUUID(),
          sessionId,
          pluginId,
          namespace: "schema",
          key: "character-attributes",
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
          narrativeOutput: pick(
            locale,
            `[系统] 从世界包全量导入：${entryRecords.length} 个维度词条，${attributes.length} 个角色属性`,
            `[System] Full import from world package: ${entryRecords.length} dimension entries, ${attributes.length} character attributes`,
          ),
          preGameDone: true,
        };
      }
    }

    // 4. Nothing found — LLM generation needed
    return { skip: false, initialized: false };
  } catch (err) {
    await ctx.logger?.warn?.("world-init guard error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { skip: false, error: String(err) };
  }
}
