import { actingCharacterOf } from "@covel/plugin-handlers-utils";
import { collectConditionRefs } from "./conditions.js";
import {
  AFFINITY_TIER_CONTRACT,
  HIDDEN_EVENTS,
  INVENTORY_BAG_CONTRACT,
  PLANNED,
} from "./constants.js";

const MAX_BAG_PAGES = 5;
const BAG_PAGE_SIZE = 50;

export async function byKey(ctx, namespace) {
  const rows = (await ctx.pluginData?.list(namespace)) ?? [];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function storedEvents(rows) {
  return rows
    .map((row) => row.value)
    .filter((event) => event && typeof event.id === "string" && event.when);
}

/**
 * Load world-authored and runtime-planned hidden events, with authored IDs
 * taking precedence.
 */
export async function loadEvents(ctx) {
  const authored = storedEvents(
    (await ctx.pluginData?.list(HIDDEN_EVENTS)) ?? [],
  );
  const authoredIds = new Set(authored.map((event) => event.id));
  const planned = storedEvents(
    (await ctx.pluginData?.list(PLANNED)) ?? [],
  ).filter((event) => !authoredIds.has(event.id));
  const events = [...authored, ...planned];
  const eventIds = new Set(events.map((event) => event.id));
  const optionIds = new Set();
  for (const event of events) {
    for (const option of event.options ?? []) {
      if (typeof option?.id === "string") optionIds.add(option.id);
    }
  }
  return { authored, planned, events, eventIds, optionIds };
}

/** Query `affinity.tier@1` only for the NPC names referenced by conditions. */
async function readAffinity(ctx, names) {
  if (!names.length || !ctx.services?.discover) return null;
  try {
    const providers =
      (await ctx.services.discover(AFFINITY_TIER_CONTRACT)) ?? [];
    if (providers.length !== 1) return null;
    const known = new Map();
    for (const name of names) {
      const answer = await ctx.services.call(
        { ...providers[0], input: { name } },
        { signal: ctx.signal },
      );
      const [character] = answer?.characters ?? [];
      if (character) {
        known.set(name.trim().toLowerCase(), {
          name: character.name,
          score: character.score,
          tier: character.tier,
        });
      }
    }
    return known;
  } catch {
    ctx.signal?.throwIfAborted();
    return null;
  }
}

/** Query `inventory.bag@2` (paginated) only when an item condition exists. */
async function readInventory(ctx, needed) {
  if (!needed || !ctx.services?.discover) return null;
  try {
    const providers =
      (await ctx.services.discover(INVENTORY_BAG_CONTRACT)) ?? [];
    if (providers.length !== 1) return null;
    const items = new Map();
    let offset = 0;
    for (let page = 0; page < MAX_BAG_PAGES; page += 1) {
      const answer = await ctx.services.call(
        { ...providers[0], input: { offset } },
        { signal: ctx.signal },
      );
      const batch = Array.isArray(answer?.items) ? answer.items : [];
      for (const item of batch) {
        if (typeof item?.name === "string" && item.name.trim()) {
          items.set(item.name.trim().toLowerCase(), item);
        }
      }
      const total = Number(answer?.total ?? batch.length);
      offset += batch.length;
      if (batch.length === 0 || offset >= total || batch.length < BAG_PAGE_SIZE)
        break;
    }
    return items;
  } catch {
    ctx.signal?.throwIfAborted();
    return null;
  }
}

/** Read the active player character's sheet fields from the world view. */
function readPlayerFields(ctx) {
  const characters = ctx.world?.characters;
  if (!Array.isArray(characters) || characters.length === 0) return null;
  const seats = Array.isArray(ctx.world?.seats) ? ctx.world.seats : [];
  const actions = Array.isArray(ctx.playerActions) ? ctx.playerActions : [];
  const actor =
    actingCharacterOf(actions, characters, seats) ??
    characters.find((character) => character?.type === "player");
  if (!actor || !actor.fields || typeof actor.fields !== "object") return null;
  return actor.fields;
}

/**
 * Build the condition evaluation state, fetching cross-plugin services only
 * when at least one hidden event or option actually references them.
 */
export async function buildConditionState(
  ctx,
  {
    events,
    eventIds,
    optionIds,
    revealed,
    selectedOptions,
    judgments,
    dimensions,
    time,
    turn,
    turnId,
    sourceTurnId,
  },
) {
  const refs = {
    affinityNames: new Set(),
    usesItems: false,
    usesAttributes: false,
    usesJudge: false,
  };
  for (const event of events) {
    collectConditionRefs(event.when, refs);
    for (const option of event.options ?? []) {
      if (option?.when) collectConditionRefs(option.when, refs);
    }
  }
  const [affinity, items] = await Promise.all([
    readAffinity(ctx, [...refs.affinityNames]),
    readInventory(ctx, refs.usesItems),
  ]);
  const playerFields = refs.usesAttributes ? readPlayerFields(ctx) : null;
  return {
    dimensions: dimensions ?? {},
    time: time ?? null,
    affinity,
    items,
    playerFields,
    revealed: revealed ?? {},
    selectedOptions: selectedOptions ?? {},
    judgments: judgments ?? {},
    eventIds,
    optionIds,
    turn,
    turnId,
    sourceTurnId,
    locale: ctx.locale,
  };
}

/**
 * Normalize player input / option text for deterministic exact-match lookup.
 * Collapses whitespace and trims surrounding quotes and sentence-end punctuation.
 */
export function normalizeActionText(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "")
    .replace(/[\s]+/g, " ")
    .replace(/[.!?。！？…]+$/g, "")
    .trim()
    .toLowerCase();
}
