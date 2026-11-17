import { pickLocaleText } from "@covel/plugin-handlers-utils";
import { attributeName, checkAttributes, namesOf } from "./attributes.js";
import { DIFFICULTY_DCS, MODIFIER_LIMIT, resolveCheck } from "./check-rules.js";

/**
 * What changes a check this turn besides the die: the modifier of each check
 * attribute (with the best item the player carries for it), and the reasons
 * that make a check harder (an NPC who will not cooperate, a full clock).
 *
 * The roller builds the plan before the story is written and tells the
 * narrative; the receipt guard, the recorder and the review hook judge a
 * receipt by the same plan through `judgeCheck`, so the narrative is held to
 * the modifier and the difficulty it was told.
 *
 * Items come from `inventory.bag@2` (`effects.check` of an item) and tiers
 * from `affinity.tier@1`. Each is read only when exactly one plugin
 * provides it; without one, that part of the plan is empty.
 */

const BAG_CONTRACT = "inventory.bag@2";
const TIER_CONTRACT = "affinity.tier@1";
const DIFFICULTIES = Object.keys(DIFFICULTY_DCS);

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

async function single(ctx, contract) {
  if (!ctx.services) return null;
  const providers = await ctx.services.discover(contract);
  return providers.length === 1 ? providers[0] : null;
}

/**
 * What the player character carries, or null without one inventory.
 * `held(names)` looks up a missing name directly if a later page failed.
 *
 * @param {import("@covel/plugin-handlers-utils").PluginFunctionContext} ctx
 */
export async function readBag(ctx) {
  try {
    const provider = await single(ctx, BAG_CONTRACT);
    if (!provider) return null;
    const call = (input) =>
      ctx.services.call({ ...provider, input }, { signal: ctx.signal });
    const first = await call({});
    const items = Array.isArray(first?.items) ? [...first.items] : [];
    const total = Number.isSafeInteger(first?.total)
      ? first.total
      : items.length;
    while (items.length > 0 && items.length < total) {
      try {
        const page = await call({ offset: items.length });
        if (!Array.isArray(page?.items) || page.items.length === 0) break;
        items.push(...page.items);
      } catch {
        ctx.signal?.throwIfAborted();
        break;
      }
    }
    const quantityIn = (list, name) => {
      const item = list.find(
        (candidate) => candidate?.name?.toLowerCase() === name,
      );
      return typeof item?.quantity === "number" ? item.quantity : 0;
    };
    return {
      items,
      async held(names) {
        const held = {};
        for (const name of names) {
          held[name] = quantityIn(items, name);
          if (held[name] > 0 || items.length >= total) continue;
          try {
            const found = await call({ query: name });
            held[name] = quantityIn(found?.items ?? [], name);
          } catch {
            ctx.signal?.throwIfAborted();
          }
        }
        return held;
      },
    };
  } catch {
    ctx.signal?.throwIfAborted();
    return null;
  }
}

/**
 * The NPCs who will not cooperate with the player: those whose tier is below
 * the neutral one, one step harder for each tier below it.
 */
async function unhelpfulCast(ctx) {
  try {
    const provider = await single(ctx, TIER_CONTRACT);
    if (!provider) return [];
    const answer = await ctx.services.call(
      { ...provider, input: {} },
      { signal: ctx.signal },
    );
    const tiers = Array.isArray(answer?.tiers) ? answer.tiers : [];
    const neutral = tiers.indexOf("neutral");
    if (neutral < 0) return [];
    return (Array.isArray(answer?.characters) ? answer.characters : [])
      .map((character) => ({
        name: character?.name,
        label: character?.label ?? character?.tier,
        steps: neutral - tiers.indexOf(character?.tier),
      }))
      .filter(
        (entry) =>
          typeof entry.name === "string" &&
          entry.steps > 0 &&
          entry.steps <= neutral,
      )
      .sort((a, b) => b.steps - a.steps);
  } catch {
    ctx.signal?.throwIfAborted();
    return [];
  }
}

/** Each check attribute by its id and by every name it has, lower-case. */
export function attributeIds(world) {
  const ids = {};
  for (const attribute of checkAttributes(world))
    for (const name of [attribute.id, ...namesOf(attribute)])
      if (typeof name === "string" && name.trim())
        ids[name.trim().toLowerCase()] = attribute.id;
  return ids;
}

/**
 * The check plan of this turn.
 *
 * @param {import("@covel/plugin-handlers-utils").PluginFunctionContext} ctx
 * @param {{ player: any, bag: Awaited<ReturnType<typeof readBag>>, clocks?: Record<string, any> }} sources
 */
export async function loadCheckPlan(ctx, { player, bag, clocks = {} }) {
  const attributes = attributeIds(ctx.world);
  // The best item for each attribute; the bag lists equipped items first.
  const items = {};
  for (const item of bag?.items ?? []) {
    const effect = item?.effects?.check;
    const id = attributes[String(effect?.attribute ?? "").toLowerCase()];
    if (!id || !Number.isInteger(effect.modifier)) continue;
    if (!items[id] || effect.modifier > items[id].modifier)
      items[id] = { name: item.name, modifier: effect.modifier };
  }
  const modifiers = {};
  const names = {};
  for (const attribute of checkAttributes(ctx.world)) {
    names[attribute.id] = attributeName(attribute, ctx.locale);
    const value = player?.fields?.[attribute.id];
    if (typeof value !== "number") continue;
    const min = typeof attribute.min === "number" ? attribute.min : 0;
    // `tabletop-rules` converts the same way (`checkModifier` in its
    // `lib/rules.js`); change both together.
    const base = Math.round(
      ((Math.min(Math.max(value, min), attribute.max) - min) /
        (attribute.max - min)) *
        MODIFIER_LIMIT,
    );
    const item = items[attribute.id];
    const total = Math.max(
      -MODIFIER_LIMIT,
      Math.min(MODIFIER_LIMIT, base + (item?.modifier ?? 0)),
    );
    modifiers[attribute.id] = {
      name: names[attribute.id],
      value,
      max: attribute.max,
      base,
      total,
      ...(item ? { item } : {}),
    };
  }
  const raised = {};
  for (const clock of Object.values(clocks)) {
    if (clock.filled < clock.segments) continue;
    for (const raw of clock.raises ?? []) {
      const id = attributes[String(raw).toLowerCase()];
      if (id) (raised[id] ??= []).push(clock.name);
    }
  }
  return {
    attributes,
    names,
    modifiers,
    raised,
    unhelpful: await unhelpfulCast(ctx),
  };
}

/**
 * An attribute must be one of the turn's listed modifiers. Without available
 * modifiers the receipt must leave out the attribute and use zero.
 *
 * @param {number} roll
 * @param {{ attribute?: unknown, modifier: number, difficulty: string, with?: unknown }} check
 * @param {any} plan The check plan, or null.
 */
export function judgeCheck(roll, check, plan) {
  if (!plan) return { problem: "this turn has no check plan" };
  const id =
    typeof check.attribute === "string"
      ? plan.attributes[check.attribute.trim().toLowerCase()]
      : undefined;
  const listed =
    id && Object.hasOwn(plan.modifiers, id) ? plan.modifiers[id] : undefined;
  if (!listed) {
    const names = Object.values(plan.modifiers).map((entry) => entry.name);
    if (names.length > 0)
      return {
        problem: `choose an attribute from the modifier list: ${names.join(", ")}`,
      };
    if (check.attribute !== undefined)
      return {
        problem:
          "omit attribute and use modifier 0 because there are no listed attributes",
      };
  }
  const reasons = [];
  for (const clock of (id && plan?.raised?.[id]) || [])
    reasons.push({ text: clock, steps: 1 });
  const partner =
    typeof check.with === "string" ? check.with.trim().toLowerCase() : "";
  const unhelpful = partner
    ? plan?.unhelpful?.find((entry) => entry.name.toLowerCase() === partner)
    : undefined;
  if (unhelpful)
    reasons.push({
      text: `${unhelpful.name} (${unhelpful.label})`,
      steps: unhelpful.steps,
    });
  const steps = reasons.reduce((sum, reason) => sum + reason.steps, 0);
  const chosen = DIFFICULTIES.indexOf(check.difficulty);
  const difficulty =
    DIFFICULTIES[Math.min(chosen + steps, DIFFICULTIES.length - 1)];
  const modifier = listed?.total ?? 0;
  return {
    result: resolveCheck(roll, modifier, difficulty),
    ...(listed?.item ? { item: listed.item } : {}),
    ...(difficulty !== check.difficulty
      ? { chosen: check.difficulty, reasons }
      : {}),
  };
}

/** "Pocket torch +2", the item in a check's modifier, for people. */
export function itemText(item) {
  return `${item.name} ${signed(item.modifier)}`;
}

/** The modifier list line of one attribute, with the item it includes. */
export function modifierLine(entry, locale) {
  const head = `- ${entry.name} ${entry.value}/${entry.max} → ${signed(entry.total)}`;
  if (!entry.item) return head;
  return pickLocaleText(
    locale,
    `${head}（${signed(entry.base)}，${itemText(entry.item)}）`,
    `${head} (${signed(entry.base)}, ${itemText(entry.item)})`,
  );
}

/**
 * The section of the check context that says which checks are harder this
 * turn and why. Empty when none is.
 */
export function harderContext(plan, locale) {
  if (!plan) return "";
  const pick = (zh, en) => pickLocaleText(locale, zh, en);
  const steps = (n) =>
    pick(
      n === 1 ? "难一档" : `难 ${n} 档`,
      n === 1 ? "one step harder" : `${n} steps harder`,
    );
  const lines = [
    ...plan.unhelpful.map((entry) =>
      pick(
        `- ${entry.name}（${entry.label}）不愿帮你。行动要靠他配合或同意时，在回执的 \`with\` 里写上这个名字：${steps(entry.steps)}。`,
        `- ${entry.name} (${entry.label}) does not want to help you. When an action needs this person's help or agreement, put the name in \`with\` in the receipt: ${steps(entry.steps)}.`,
      ),
    ),
    ...Object.entries(plan.raised).map(([id, clocks]) => {
      const name = plan.names[id] ?? id;
      return pick(
        `- ${clocks.join("、")}已满：${name}检定${steps(clocks.length)}。`,
        `- ${clocks.join(", ")} is full: ${name} checks are ${steps(clocks.length)}.`,
      );
    }),
  ];
  if (lines.length === 0) return "";
  return [
    pick("## 更难的检定", "## Harder checks"),
    "",
    pick(
      "本回合有些检定更难。照常根据情境定难度，并在回执里报告你定的难度；然后按下面每条原因往右移相应的档数，在那一列读结果（极难不再往右移）。系统会按同样的规则核对。",
      "Some checks are harder this turn. Choose the difficulty from the fiction as usual and report that difficulty in the receipt; then move one column to the right for each step below and read the outcome there (extreme stays extreme). The system checks the receipt by the same rule.",
    ),
    ...lines,
  ].join("\n");
}
