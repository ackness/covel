import {
  withPendingProposals,
  makeProposal,
  pickLocaleText as pick,
} from "@covel/plugin-handlers-utils";

import { resolveI18nText } from "@covel/shared";

/**
 * guard.js — Pre-execution gate for schema-gen runtime.
 *
 * Runs before LLM is called. Checks whether world schema/entries can be
 * obtained without generation — from this session's own plugin-data, from
 * `world.yaml` declared character attributes, or derived from world
 * dimensions. When any of those hold it returns { skip: true } and the LLM
 * call is bypassed. Only sessions of a world that supplies none of them pay
 * for a schema-gen call.
 *
 * Data from OTHER sessions is never read — see the note at step 2b below.
 *
 * @param {import('@covel/plugin-handlers-utils').PluginFunctionContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
/**
 * Derive a character attribute schema from world dimensions.
 * Used when world.yaml has dimensions but no explicit schemas field —
 * avoids an LLM call by inferring sensible attributes from world data.
 *
 * @param {Record<string, unknown>} dimensions
 * @param {string | undefined} locale
 * @returns {Array<Record<string, unknown>>}
 */
function deriveSchema(dimensions, locale) {
  /** @type {Array<Record<string, unknown>>} */
  // Attribute name/description are I18nText ({ "zh-CN", "en-US" }) so the
  // display layer resolves them per session locale (character-schema.ts types
  // them as I18nText). Worlds with declared characterSchema override this.
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
      resolveI18nText(firstCurrency.name, locale) ??
      pick(locale, "货币", "Currency");
    attrs.push({
      id: "gold",
      name: currName,
      type: "number",
      min: 0,
      defaultValue: 0,
      category: "stats",
      description: pick(
        locale,
        `持有的${currName}数量`,
        `Amount of ${currName} held`,
      ),
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
        return resolveI18nText(n, locale) ?? "Tier";
      })
      .filter(Boolean);

    if (tierOptions.length > 0) {
      const psName = powerSystem.name;
      const attrName =
        resolveI18nText(psName, locale) ?? pick(locale, "境界", "Power tier");
      attrs.push({
        id: "powerTier",
        name: attrName,
        type: "enum",
        options: tierOptions,
        defaultValue: tierOptions[0],
        category: "abilities",
        description: pick(locale, `${attrName}等级`, `${attrName} level`),
      });
    }
  }

  return attrs;
}

/** Reuse the authoritative schema or derive one from authored dimensions. */
export default async function guard(ctx) {
  const { locale } = ctx;
  const existing = ctx.world.characterSchema;
  const entries = await ctx.store.listPluginData("entries");
  if (existing && entries.length > 0) {
    return {
      skip: true,
      initialized: true,
      preGameDone: true,
      schemaCount: existing.attributes.length,
      entryCount: entries.length,
      worldSchema: existing,
      narrativeOutput: pick(
        locale,
        "[系统] 世界资料已加载",
        "[System] World data loaded",
      ),
    };
  }
  const world = ctx.world.worldRecord;
  const dimensions = world?.dimensions ?? world?.metadata?.dimensions;
  const declared = world?.metadata?.characterSchema;
  const attributes =
    existing?.attributes ??
    declared?.attributes ??
    (dimensions ? deriveSchema(dimensions, locale) : null);
  if (!attributes) return { skip: false, initialized: false };
  const schema = {
    types: existing?.types ?? declared?.types ?? ["npc", "companion"],
    attributes,
  };
  const now = new Date().toISOString();
  const proposals = [];
  if (!existing)
    proposals.push(makeProposal(ctx, now, "character.schema.set", schema));
  const items = Object.entries(dimensions ?? {}).map(([key, value]) => ({
    namespace: "entries",
    key,
    value,
  }));
  if (items.length)
    proposals.push(makeProposal(ctx, now, "plugin.data.batch", { items }));
  return withPendingProposals(
    {
      skip: true,
      initialized: true,
      importedDimensions: items.length > 0,
      preGameDone: true,
      schemaCount: attributes.length,
      entryCount: items.length,
      worldSchema: schema,
      narrativeOutput: pick(
        locale,
        `[系统] 世界资料已加载（${attributes.length} 个属性）`,
        `[System] World data loaded (${attributes.length} attributes)`,
      ),
    },
    proposals,
  );
}
