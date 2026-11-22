import {
  compareText,
  pickLocaleText,
  resolveI18nText,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { hasJudgeLeaf, inspectCondition } from "../../lib/conditions.js";
import {
  ACTIVE_OPTIONS,
  ARMED,
  CLAIMED_REWARDS,
  JUDGMENTS,
  NARRATIVE_NOTES,
  NO_CUE,
  PENDING_OPTIONS,
  REVEALED,
  SELECTED_OPTIONS,
} from "../../lib/constants.js";
import {
  buildTurnSignals,
  passesWatch,
  persistJudgeVerdicts,
  resolveMaxJudged,
  runSemanticJudge,
} from "../../lib/judge.js";
import {
  applyOptionSelection,
  findExactSelectedOption,
  findOptionDefinition,
} from "../../lib/options.js";
import {
  buildStoryContextNote,
  grantRewards,
  rewardKeyOf,
} from "../../lib/rewards.js";
import { isEventAvailable, selectEvent } from "../../lib/select.js";
import {
  buildConditionState,
  byKey,
  loadEvents,
} from "../../lib/state-readers.js";

// What the narrative is told to do with a cue: an instruction, so English,
// and Chinese for a Simplified Chinese session.
const cueInstruction = (locale) =>
  pickLocaleText(
    locale,
    "当前状态刚刚解锁了一个隐藏的故事事件。把它自然地带进本回合，写成场景里发生的事；不要提到条件、触发器，也不要提到它曾被隐藏。",
    "A hidden story event has just been unlocked by the current state. Bring it into this turn naturally, as something that happens in the scene; do not mention conditions, triggers, or that it was hidden.",
  );

const optionCueInstruction = (locale) =>
  pickLocaleText(
    locale,
    "玩家刚刚选择了刚刚解锁的一个隐藏行动。根据下面的剧情简述自然写出这件事的发生与后果；不要提到选项、条件、触发器，也不要提到它曾被隐藏。",
    "The player has just chosen a newly unlocked hidden action. Follow the brief below to stage what happens and its consequences naturally in the scene; do not mention options, conditions, triggers, or that it was hidden.",
  );

// The turn after a cue, the narrative gets the same event once more. A model
// that left the cue out of its narrative would otherwise lose a one-time
// event for good; one that used it is told to go on from it.
const reminderInstruction = (locale) =>
  pickLocaleText(
    locale,
    "上一回合已经把下面这个隐藏的故事事件交给了叙事。对照上一回合的正文：如果这件事还没有发生，就在本回合自然地带进来，写成场景里发生的事；如果已经发生，不要重复，接着写它带来的后果。不要提到条件、触发器，也不要提到它曾被隐藏。",
    "The hidden story event below was given to the narrative in the previous turn. Read the narrative of the previous turn. If the event did not happen there, bring it into this turn naturally, as something that happens in the scene. If it already happened, do not repeat it; continue from its consequences. Do not mention conditions, triggers, or that it was hidden.",
  );

/**
 * What planners may know: fired events and pending planned events, by ID and
 * public title only. Pending world-authored events stay out of it entirely.
 */
function ledger(planned, revealed, turn, locale) {
  const title = (value) =>
    value ? { title: resolveI18nText(value, locale) ?? "" } : {};
  return {
    turn,
    revealed: Object.values(revealed).map((record) => ({
      eventId: record.eventId,
      ...title(record.title),
      lastTurn: record.lastTurn,
    })),
    planned: planned
      .filter((event) => !revealed[event.id])
      .map((event) => ({
        eventId: event.id,
        ...title(event.title),
        plannedTurn: event.plannedTurn,
      })),
  };
}

function finalizeResult(value, proposals) {
  const result = { outcome: "success", value };
  return proposals.length > 0
    ? withPendingProposals(result, proposals)
    : result;
}

function noCue(
  diagnostics,
  book,
  storyContext,
  selectedOption,
  proposals = [],
) {
  return finalizeResult(
    {
      cue: null,
      cueContext: NO_CUE,
      ledger: book,
      ...(storyContext ? { storyContext } : {}),
      ...(selectedOption ? { selectedOption } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
    },
    proposals,
  );
}

function cueResult({
  eventId,
  optionId,
  title,
  payload,
  locale,
  diagnostics,
  book,
  reminder = false,
  isOption = false,
  storyContext = null,
  selectedOption = null,
  proposals = [],
}) {
  const resolvedPayload = resolveI18nText(payload, locale) ?? "";
  const resolvedTitle = title ? resolveI18nText(title, locale) : undefined;
  const instruction = reminder
    ? reminderInstruction(locale)
    : isOption
      ? optionCueInstruction(locale)
      : cueInstruction(locale);
  return finalizeResult(
    {
      cue: {
        eventId,
        ...(optionId ? { optionId } : {}),
        ...(resolvedTitle ? { title: resolvedTitle } : {}),
        payload: resolvedPayload,
        ...(reminder ? { reminder: true } : {}),
      },
      cueContext: `${instruction}\n\n${resolvedPayload}`,
      ledger: book,
      ...(storyContext ? { storyContext } : {}),
      ...(selectedOption ? { selectedOption } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
    },
    proposals,
  );
}

async function stageRewards({
  ctx,
  eventId,
  optionId,
  rewards,
  claimedRewards,
  turn,
  sourceTurnId,
  turnNotes,
  proposals,
  diagnostics,
}) {
  if (!Array.isArray(rewards) || rewards.length === 0) return;
  const immediate = [];
  for (const reward of rewards) {
    if (reward.requireOutcome === true) {
      const key = rewardKeyOf(eventId, optionId, reward.id);
      if (!claimedRewards[key]) {
        await ctx.pluginData.set(PENDING_OPTIONS, key, {
          rewardKey: key,
          eventId,
          ...(optionId ? { optionId } : {}),
          rewardId: reward.id,
          turn,
          turnId: ctx.turnId,
          sourceTurnId,
        });
      }
    } else {
      immediate.push({ eventId, optionId, reward });
    }
  }
  if (immediate.length === 0) return;
  const settled = await grantRewards(ctx, {
    grants: immediate,
    claimedRewards,
    operations: [],
    worldIR: null,
    turn,
    turnId: ctx.turnId,
    sourceTurnId,
  });
  proposals.push(...settled.proposals);
  turnNotes.push(...settled.narrativeNotes);
  diagnostics.push(...settled.diagnostics);
  for (const write of settled.claimedWrites) {
    claimedRewards[write.key] = write.value;
    await ctx.pluginData.set(CLAIMED_REWARDS, write.key, write.value);
  }
}

export default async function handler(ctx) {
  const { planned, events, eventIds, optionIds } = await loadEvents(ctx);
  const revealed = await byKey(ctx, REVEALED);
  const revealedRows = Object.entries(revealed).map(([key, value]) => ({
    key,
    value,
  }));
  const turn = ctx.logicalTurn ?? 1;
  const sourceTurnId = ctx.execution?.sourceTurnId ?? ctx.turnId;
  const book = ledger(planned, revealed, turn, ctx.locale);

  // Consume one-turn narrative notes queued by the previous turn's `audit`.
  const turnNotes = [];
  const queuedNotes = await byKey(ctx, NARRATIVE_NOTES);
  for (const [key, value] of Object.entries(queuedNotes)) {
    if (typeof value?.text === "string" && value.text.trim()) {
      turnNotes.push(value.text.trim());
    }
    await ctx.pluginData.set(NARRATIVE_NOTES, key, null);
  }

  if (!events.length) {
    return noCue([], book, buildStoryContextNote(turnNotes, ctx.locale));
  }

  const activeOptions = await byKey(ctx, ACTIVE_OPTIONS);
  const selectedOptions = await byKey(ctx, SELECTED_OPTIONS);
  const armed = await byKey(ctx, ARMED);
  const judgments = await byKey(ctx, JUDGMENTS);
  const claimedRewards = await byKey(ctx, CLAIMED_REWARDS);

  // Retry idempotency: re-deliver whatever this source turn already revealed.
  const repeatedSelection = Object.values(selectedOptions).find(
    (row) => row?.lastTurnId === sourceTurnId,
  );
  if (repeatedSelection) {
    const found = findOptionDefinition(
      events,
      repeatedSelection.eventId,
      repeatedSelection.optionId,
    );
    const sel = {
      eventId: repeatedSelection.eventId,
      optionId: repeatedSelection.optionId,
    };
    if (found?.option.payload) {
      return cueResult({
        eventId: found.event.id,
        optionId: found.option.id,
        title: found.option.label ?? found.event.title,
        payload: found.option.payload,
        locale: ctx.locale,
        diagnostics: [],
        book,
        isOption: true,
        storyContext: buildStoryContextNote(turnNotes, ctx.locale),
        selectedOption: sel,
      });
    }
  }

  const repeat = revealedRows.find(
    (row) => row.value?.lastTurnId === sourceTurnId,
  );
  if (repeat) {
    const event = events.find((item) => item.id === repeat.key);
    if (event?.payload) {
      return cueResult({
        eventId: event.id,
        title: event.title,
        payload: event.payload,
        locale: ctx.locale,
        diagnostics: [],
        book,
        storyContext: buildStoryContextNote(turnNotes, ctx.locale),
      });
    }
  }

  const repeatedReminder = revealedRows.find(
    (row) => row.value?.reminderTurnId === sourceTurnId,
  );
  if (repeatedReminder) {
    const event = events.find((item) => item.id === repeatedReminder.key);
    if (event?.payload) {
      return cueResult({
        eventId: event.id,
        title: event.title,
        payload: event.payload,
        locale: ctx.locale,
        diagnostics: [],
        book,
        reminder: true,
        storyContext: buildStoryContextNote(turnNotes, ctx.locale),
      });
    }
  }

  const proposals = [];
  const diagnostics = [];
  let selectedOption = null;

  // 1. Check for exact normalized match against an active unlocked hidden option.
  const exactOption = findExactSelectedOption(activeOptions, ctx.playerMessage);
  if (exactOption) {
    const found = findOptionDefinition(
      events,
      exactOption.eventId,
      exactOption.id,
    );
    if (found) {
      const { event, option } = found;
      selectedOption = { eventId: event.id, optionId: option.id };
      const { record: nextSelection, removedActiveIds } = applyOptionSelection({
        event,
        option,
        selectedOptions,
        activeOptions,
        turn,
        sourceTurnId,
      });
      await ctx.pluginData.set(SELECTED_OPTIONS, option.id, nextSelection);
      for (const removedId of removedActiveIds) {
        await ctx.pluginData.set(ACTIVE_OPTIONS, removedId, null);
      }

      await stageRewards({
        ctx,
        eventId: event.id,
        optionId: option.id,
        rewards: option.rewards,
        claimedRewards,
        turn,
        sourceTurnId,
        turnNotes,
        proposals,
        diagnostics,
      });

      if (option.payload) {
        return cueResult({
          eventId: event.id,
          optionId: option.id,
          title: option.label ?? event.title,
          payload: option.payload,
          locale: ctx.locale,
          diagnostics,
          book,
          isOption: true,
          storyContext: buildStoryContextNote(turnNotes, ctx.locale),
          selectedOption,
          proposals,
        });
      }
    }
  }

  // 2. Deliver any option payload armed by the previous turn's `audit` judge
  //    (when the player reworded or free-typed an unlocked hidden option).
  const armedOptionEntry = Object.values(armed).find(
    (entry) => entry && typeof entry.optionId === "string",
  );
  if (armedOptionEntry) {
    await ctx.pluginData.set(
      ARMED,
      `${armedOptionEntry.eventId}:${armedOptionEntry.optionId}`,
      null,
    );
    const found = findOptionDefinition(
      events,
      armedOptionEntry.eventId,
      armedOptionEntry.optionId,
    );
    if (found?.option.payload) {
      // Queue any unclaimed `requireOutcome` rewards so they verify against this
      // turn's narration of the armed option payload.
      await stageRewards({
        ctx,
        eventId: found.event.id,
        optionId: found.option.id,
        rewards: found.option.rewards,
        claimedRewards,
        turn,
        sourceTurnId,
        turnNotes,
        proposals,
        diagnostics,
      });
      return cueResult({
        eventId: found.event.id,
        optionId: found.option.id,
        title: found.option.label ?? found.event.title,
        payload: found.option.payload,
        locale: ctx.locale,
        diagnostics,
        book,
        isOption: true,
        storyContext: buildStoryContextNote(turnNotes, ctx.locale),
        selectedOption,
        proposals,
      });
    }
  }

  // 3. Build unified state (fetching cross-plugin services only if referenced).
  const dimensions =
    ctx.inputs?.dimensions?.value ?? ctx.world?.dimensions ?? {};
  const time = ctx.inputs?.worldTime?.value ?? null;
  const state = await buildConditionState(ctx, {
    events,
    eventIds,
    optionIds,
    revealed,
    selectedOptions,
    judgments,
    dimensions,
    time,
    turn,
    turnId: ctx.turnId,
    sourceTurnId,
  });

  // 4. Optional explicit `timing: "pre-turn"` semantic judge (only when author
  //    opted in AND deterministic gates pass AND watch matches).
  const semanticEnabled = ctx.userSettings?.semanticJudge !== false;
  if (semanticEnabled) {
    const preTurnSignals = buildTurnSignals({
      narrativeSegments: [],
      playerMessage: ctx.playerMessage,
      worldIR: null,
      dimensions,
      worldTime: time,
      turn,
    });
    const pendingByKey = new Map();
    for (const event of events) {
      if (event.timing !== "pre-turn" || !event.payload) continue;
      if (!isEventAvailable(event, revealed[event.id], turn)) continue;
      if (armed[event.id] || !hasJudgeLeaf(event.when)) continue;
      const inspected = inspectCondition(event.when, state, {
        scopeId: event.id,
        semanticEnabled: true,
        deferSemantic: false,
      });
      if (inspected.status !== "pending") continue;
      for (const leaf of inspected.pending) {
        if (!passesWatch(leaf, preTurnSignals)) continue;
        if (!pendingByKey.has(leaf.key)) {
          pendingByKey.set(leaf.key, {
            ...leaf,
            priority: event.priority ?? 0,
            eventId: event.id,
          });
        }
      }
    }
    if (pendingByKey.size > 0) {
      const candidates = [...pendingByKey.values()].sort(
        (a, b) => b.priority - a.priority || compareText(a.key, b.key),
      );
      const judged = await runSemanticJudge(ctx, {
        candidates,
        signals: preTurnSignals,
        maxJudged: resolveMaxJudged(ctx.userSettings),
      });
      diagnostics.push(...judged.diagnostics);
      await persistJudgeVerdicts(ctx, {
        candidates,
        verdicts: judged.verdicts,
        judgments,
        signals: preTurnSignals,
        turn,
        sourceTurnId,
      });
    }
  }

  // 5. Select at most one story-cue event (armed semantic + deterministic +
  //    newly resolved pre-turn semantic).
  const { event, diagnostics: selectDiagnostics } = selectEvent({
    events,
    revealed,
    state,
    turn,
    armed,
    evalOptions: {
      semanticEnabled,
      deferSemantic: true,
    },
  });
  diagnostics.push(...selectDiagnostics);

  if (!event) {
    // A new event takes the turn; without one, last turn's event is given a
    // second time, and only this once.
    const due = revealedRows.find(
      (row) => row.value?.lastTurn === turn - 1 && !row.value.reminderTurnId,
    );
    const last =
      due && events.find((item) => item.id === due.key && item.payload);
    if (!last) {
      return noCue(
        [...new Set(diagnostics)],
        book,
        buildStoryContextNote(turnNotes, ctx.locale),
        selectedOption,
        proposals,
      );
    }
    await ctx.pluginData.set(REVEALED, due.key, {
      ...due.value,
      reminderTurnId: sourceTurnId,
    });
    return cueResult({
      eventId: last.id,
      title: last.title,
      payload: last.payload,
      locale: ctx.locale,
      diagnostics: [...new Set(diagnostics)],
      book,
      reminder: true,
      storyContext: buildStoryContextNote(turnNotes, ctx.locale),
      selectedOption,
      proposals,
    });
  }

  const previous = revealed[event.id];
  // The reveal record is public: it names the event (and its optional public
  // title) but never stores the hidden payload.
  const record = {
    eventId: event.id,
    ...(event.title ? { title: event.title } : {}),
    firstTurn: previous?.firstTurn ?? turn,
    lastTurn: turn,
    lastTurnId: sourceTurnId,
    count: (previous?.count ?? 0) + 1,
  };
  await ctx.pluginData.set(REVEALED, event.id, record);
  if (armed[event.id]) {
    await ctx.pluginData.set(ARMED, event.id, null);
  }

  await stageRewards({
    ctx,
    eventId: event.id,
    optionId: undefined,
    rewards: event.rewards,
    claimedRewards,
    turn,
    sourceTurnId,
    turnNotes,
    proposals,
    diagnostics,
  });

  return cueResult({
    eventId: event.id,
    title: event.title,
    payload: event.payload,
    locale: ctx.locale,
    diagnostics: [...new Set(diagnostics)],
    book: ledger(
      planned,
      { ...revealed, [event.id]: record },
      turn,
      ctx.locale,
    ),
    storyContext: buildStoryContextNote(turnNotes, ctx.locale),
    selectedOption,
    proposals,
  });
}
