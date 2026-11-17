import {
  labelText,
  makeProposal,
  pickLocaleText,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { deadlinePassed, namedNpcs, timeLeft } from "../../lib/deadlines.js";
import { CHANGE_COLOR, toChips } from "../../lib/upsert-quests.js";

const TIER_CONTRACT = "affinity.tier@1";

/**
 * Fail the quests and objectives whose deadline has passed, before the story
 * is written, and tell the story what is due.
 *
 * The state is this turn's frozen dimensions and the world time of this
 * execution, so a deadline passes on the turn after the one that ran out
 * of time, and the story of that turn says so. The output's `storyContext`
 * is the note the story reads through `story-context@1`.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function handler(ctx) {
  const rows = (await ctx.store.listPluginData("quests")) ?? [];
  const sourceTurnId = ctx.execution?.sourceTurnId ?? ctx.turnId;
  const affinityNames = namedNpcs(rows.map((row) => row?.value));
  const state = {
    dimensions: ctx.world?.dimensions ?? {},
    time: ctx.inputs?.worldTime?.value ?? null,
    affinity: affinityNames.length
      ? await affinityOf(ctx, affinityNames)
      : null,
    turn: ctx.logicalTurn,
  };
  const missedNow = (deadline) => ({
    label: deadline.label,
    text: missedText(deadline),
    turnId: sourceTurnId,
    ...(Number.isInteger(ctx.logicalTurn) ? { turn: ctx.logicalTurn } : {}),
  });

  const writes = [];
  const changes = [];
  const due = [];
  const failed = [];
  for (const row of rows) {
    const quest = row?.value;
    if (!quest || typeof quest.name !== "string") continue;
    // A retried turn tells the story again what it failed the first time.
    if (quest.missed?.turnId === sourceTurnId)
      failed.push({ quest: quest.name, text: quest.missed.text });
    for (const objective of quest.objectives ?? [])
      if (objective?.missed?.turnId === sourceTurnId)
        failed.push({
          quest: quest.name,
          objective: objective.text,
          text: objective.missed.text,
        });
    if ((quest.status ?? "active") !== "active") continue;

    let next = quest;
    const questChanges = [];
    if (isDeadline(quest.deadline)) {
      if (deadlinePassed(quest.deadline.when, state) === true) {
        next = { ...next, status: "failed", missed: missedNow(quest.deadline) };
        questChanges.push({ change: "failed", text: next.missed.text });
        failed.push({ quest: quest.name, text: next.missed.text });
      } else {
        due.push({ quest: quest.name, deadline: quest.deadline });
      }
    }
    const objectives = (quest.objectives ?? []).map((objective) => {
      // A quest that failed now takes its open objectives with it.
      if (
        next.status === "failed" ||
        objective?.done ||
        objective?.missed ||
        !isDeadline(objective?.deadline)
      )
        return objective;
      if (deadlinePassed(objective.deadline.when, state) !== true) {
        due.push({
          quest: quest.name,
          objective: objective.text,
          deadline: objective.deadline,
        });
        return objective;
      }
      const missed = missedNow(objective.deadline);
      questChanges.push({ change: "missed", text: missed.text });
      failed.push({
        quest: quest.name,
        objective: objective.text,
        text: missed.text,
      });
      return { ...objective, missed };
    });
    const key = row.key ?? quest.id;
    if (questChanges.length === 0) {
      // The panel shows an open deadline from the first turn on, also on a
      // quest that the world seeded without chips.
      const chips = toChips(quest);
      const timed =
        isDeadline(quest.deadline) ||
        objectives.some((objective) => isDeadline(objective?.deadline));
      if (timed && JSON.stringify(chips) !== JSON.stringify(quest.chips))
        writes.push({ namespace: "quests", key, value: { ...quest, chips } });
      continue;
    }
    next = {
      ...next,
      objectives,
      isNew: false,
      ...(Number.isInteger(ctx.logicalTurn)
        ? { updatedTurn: ctx.logicalTurn }
        : {}),
    };
    writes.push({
      namespace: "quests",
      key,
      value: { ...next, chips: toChips(next) },
    });
    for (const [index, change] of questChanges.entries())
      changes.push({
        // Its own entry: the log may change the same quest this turn.
        id: `${quest.id ?? key}#deadline-${index}`,
        name: quest.name,
        change: change.change,
        badge: deadlineBadge(ctx, change.change),
        color: CHANGE_COLOR[change.change],
        detail: change.text,
      });
  }

  // A nested execution reads the deadlines; only the turn itself writes.
  const writing = !ctx.recursionDepth;
  if (changes.length > 0 && writing) {
    const previous = await ctx.store.getPluginData("message", ctx.turnId);
    writes.push({
      namespace: "message",
      key: ctx.turnId,
      value: {
        turnId: ctx.turnId,
        changes: [
          ...(Array.isArray(previous?.value?.changes)
            ? previous.value.changes
            : []),
          ...changes,
        ],
      },
    });
  }
  const result = {
    outcome: "success",
    value: {
      failed: failed.length,
      due: due.length,
      storyContext: storyNote(ctx, due, failed, state),
    },
  };
  // One batch: the quests and their changes block commit together or not at all.
  return writes.length > 0 && writing
    ? withPendingProposals(result, [
        makeProposal(ctx, new Date().toISOString(), "plugin.data.batch", {
          items: writes,
        }),
      ])
    : result;
}

/**
 * How each NPC that a deadline names feels about the player, by the name as
 * the deadline writes it (lower-case), from the single provider of
 * `affinity.tier@1`, which matches a name or a known alias; null without
 * one, so that an affinity deadline is never judged.
 */
async function affinityOf(ctx, names) {
  try {
    const providers = (await ctx.services?.discover(TIER_CONTRACT)) ?? [];
    if (providers.length !== 1) return null;
    const known = new Map();
    for (const name of names) {
      const answer = await ctx.services.call(
        { ...providers[0], input: { name } },
        { signal: ctx.signal },
      );
      const [character] = answer?.characters ?? [];
      if (character)
        known.set(name.toLowerCase(), {
          score: character.score,
          tier: character.tier,
        });
    }
    return known;
  } catch {
    ctx.signal?.throwIfAborted();
    return null;
  }
}

function isDeadline(deadline) {
  return (
    deadline &&
    typeof deadline === "object" &&
    typeof deadline.label === "string" &&
    deadline.label.trim() &&
    deadline.when
  );
}

function missedText(deadline) {
  return typeof deadline.missed === "string" && deadline.missed.trim()
    ? deadline.missed.trim()
    : deadline.label;
}

/** The badge text in every language the plugin ships. */
function deadlineBadge(ctx, change) {
  // Each text is a literal: the validator reads them from the source.
  return change === "failed"
    ? labelText(ctx, "Failed")
    : labelText(ctx, "Missed");
}

/**
 * What the story reads: the deadlines still open, with the time left when
 * the deadline counts world time, and what failed now and must happen in
 * this turn's story. Quests are named; no ID reaches the text.
 */
function storyNote(ctx, due, failed, state) {
  const pick = (zh, en) => pickLocaleText(ctx.locale, zh, en);
  const unit = state.time?.units?.[0];
  const left = (deadline) => {
    if (
      !["elapsedSinceStart", "tick"].includes(deadline.when.time) ||
      !Number.isInteger(deadline.when.gte ?? deadline.when.gt)
    )
      return "";
    const amount = timeLeft(deadline.when, state);
    if (amount === undefined || !unit) return "";
    const value = Math.max(amount, 0);
    // The base unit is the clock's English unit id (`minute`, `phase`).
    const zhUnit = { minute: "分钟", hour: "小时", day: "天" }[unit] ?? unit;
    return pick(
      `（约剩 ${value} ${zhUnit}）`,
      ` (about ${value} ${value === 1 ? unit : `${unit}s`} left)`,
    );
  };
  const line = ({ quest, objective }, text) =>
    objective
      ? pick(
          `- 「${quest}」的目标「${objective}」：${text}`,
          `- "${objective}" of ${quest}: ${text}`,
        )
      : pick(`- 「${quest}」：${text}`, `- ${quest}: ${text}`);
  const lines = [];
  if (failed.length > 0)
    lines.push(
      pick(
        "这些期限刚刚错过。本回合的故事要让结果发生，不要把错过的事再交给玩家去做：",
        "These deadlines have just passed. This turn's story makes the result happen; do not offer the missed task to the player again:",
      ),
      ...failed.map((item) => line(item, item.text)),
    );
  if (due.length > 0)
    lines.push(
      pick(
        "这些任务有期限。让玩家从故事里感到时间在流逝：",
        "These quests have deadlines. Let the player feel the time running out in the story:",
      ),
      ...due.map((item) =>
        line(item, `${item.deadline.label}${left(item.deadline)}`),
      ),
    );
  if (lines.length === 0) return null;
  return {
    title: pick("任务期限", "Quest deadlines"),
    content: lines.join("\n"),
  };
}
