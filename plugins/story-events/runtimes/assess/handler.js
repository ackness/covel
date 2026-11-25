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
  MESSAGE,
  NARRATIVE_NOTES,
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
  findOptionDefinition,
  publicOptionView,
  sortActiveOptions,
  toMessageOptionItem,
} from "../../lib/options.js";
import {
  grantRewards,
  rewardKeyOf,
  toAnnouncementItem,
} from "../../lib/rewards.js";
import { isEventAvailable } from "../../lib/select.js";
import {
  buildConditionState,
  byKey,
  loadEvents,
} from "../../lib/state-readers.js";

function defaultOutcomeQuestion(reward, option, locale) {
  const explicit = reward.outcome
    ? resolveI18nText(reward.outcome, locale)?.trim()
    : "";
  if (explicit) return explicit;
  const label =
    (reward.title && resolveI18nText(reward.title, locale)?.trim()) ||
    (reward.item && resolveI18nText(reward.item, locale)?.trim()) ||
    reward.id;
  const action = option?.text
    ? resolveI18nText(option.text, locale)?.trim()
    : "";
  return pickLocaleText(
    locale,
    action
      ? `主角在执行「${action}」后，故事明确确认主角成功获得了「${label}」（没有失败、被阻止或放弃）。`
      : `本回合故事明确确认主角成功获得了「${label}」（没有失败、被阻止或放弃）。`,
    action
      ? `After attempting "${action}", the narrative explicitly confirms the player character succeeded and obtained "${label}" (not failed, blocked, or abandoned).`
      : `This turn's narrative explicitly confirms the player character succeeded and obtained "${label}" (not failed, blocked, or abandoned).`,
  );
}

function eventOptionsBlockedByExclusive(event, selectedOptions) {
  if (event.exclusive !== true || !Array.isArray(event.options)) return false;
  return event.options.some((opt) => Boolean(selectedOptions[opt.id]));
}

function findRewardDefinition(events, eventId, optionId, rewardId) {
  const event = events.find((ev) => ev.id === eventId);
  const option = optionId
    ? event?.options?.find((opt) => opt.id === optionId)
    : null;
  const rewardList = option ? option.rewards : event?.rewards;
  const reward = rewardList?.find((r) => r.id === rewardId) ?? null;
  return { event, option, reward };
}

function makeOutcomeCandidate(key, reward, option, locale) {
  return {
    key: `outcome:${key}`,
    question: defaultOutcomeQuestion(reward, option, locale),
    scope: "narrative",
    sticky: false,
    watch: null,
    cached: null,
    priority: 1000,
  };
}

function collectJudgeCandidates({
  events,
  sortedEvents,
  pendingOutcomeEntries,
  revealed,
  selectedOptions,
  claimedRewards,
  state,
  signals,
  turn,
  locale,
}) {
  const pendingByKey = new Map();
  const addCandidate = (leaf, priority) => {
    if (!passesWatch(leaf, signals)) return;
    if (!pendingByKey.has(leaf.key)) {
      pendingByKey.set(leaf.key, { ...leaf, priority });
    }
  };

  for (const [key, item] of pendingOutcomeEntries) {
    const { option, reward } = findRewardDefinition(
      events,
      item.eventId,
      item.optionId,
      item.rewardId,
    );
    if (!reward) continue;
    const candidate = makeOutcomeCandidate(key, reward, option, locale);
    pendingByKey.set(candidate.key, candidate);
  }

  for (const event of sortedEvents) {
    if (event.enabled === false) continue;
    if (
      event.timing === "pre-turn" &&
      event.payload &&
      !event.options?.length &&
      !event.rewards?.length
    )
      continue;
    const available = isEventAvailable(event, revealed[event.id], turn);
    const hasOpenOptions =
      Array.isArray(event.options) &&
      event.options.length > 0 &&
      !eventOptionsBlockedByExclusive(event, selectedOptions) &&
      event.options.some(
        (opt) => !(opt.once !== false && selectedOptions[opt.id]),
      );
    if (!available && !hasOpenOptions) continue;

    // Payload events reveal their options only after the narrative cue has
    // actually been revealed (`revealed[event.id]`), preventing 1-turn spoilers.
    const eventAlreadyRevealed =
      Boolean(revealed[event.id]) && Boolean(event.payload);
    const inspected = eventAlreadyRevealed
      ? { status: "true", pending: [] }
      : inspectCondition(event.when, state, {
          scopeId: event.id,
          semanticEnabled: true,
          phase: "audit",
        });

    if (inspected.status === "pending") {
      for (const leaf of inspected.pending)
        addCandidate(leaf, event.priority ?? 0);
      continue;
    }

    if (inspected.status !== "true") continue;

    // Pure-reward events with deterministic/cached conditions verify their
    // `requireOutcome` rewards in the same single judge call.
    if (
      !event.payload &&
      available &&
      Array.isArray(event.rewards) &&
      event.rewards.length > 0
    ) {
      for (const reward of event.rewards) {
        if (reward.requireOutcome !== true) continue;
        const rewardKey = rewardKeyOf(event.id, undefined, reward.id);
        if (claimedRewards[rewardKey]) continue;
        const candidate = makeOutcomeCandidate(rewardKey, reward, null, locale);
        pendingByKey.set(candidate.key, candidate);
      }
    }

    const canJudgeOptions =
      hasOpenOptions && (!event.payload || Boolean(revealed[event.id]));
    if (!canJudgeOptions) continue;

    for (const option of event.options) {
      if (option.once !== false && selectedOptions[option.id]) continue;
      if (!option.when) continue;
      const optInspected = inspectCondition(option.when, state, {
        scopeId: `${event.id}:${option.id}`,
        semanticEnabled: true,
        phase: "audit",
      });
      if (optInspected.status === "pending") {
        for (const leaf of optInspected.pending)
          addCandidate(leaf, event.priority ?? 0);
      }
    }
  }

  return [...pendingByKey.values()].sort(
    (a, b) => b.priority - a.priority || compareText(a.key, b.key),
  );
}

async function settlePendingOutcomes(
  ctx,
  {
    pendingOutcomeEntries,
    events,
    semanticEnabled,
    judgeResult,
    grantsToSettle,
    diagnostics,
  },
) {
  if (pendingOutcomeEntries.length === 0) return;
  if (!semanticEnabled) {
    diagnostics.push(
      "semantic judge is disabled; deferred requireOutcome reward verification",
    );
    return;
  }
  if (judgeResult.failed) {
    // Keep pending outcome records intact so a retry can still verify them.
    return;
  }
  for (const [key, item] of pendingOutcomeEntries) {
    const verdict = judgeResult.verdicts.get(`outcome:${key}`);
    if (!verdict) continue;
    if (verdict.met === true) {
      const { reward } = findRewardDefinition(
        events,
        item.eventId,
        item.optionId,
        item.rewardId,
      );
      if (reward) {
        grantsToSettle.push({
          eventId: item.eventId,
          optionId: item.optionId,
          reward,
        });
      }
    }
    await ctx.pluginData.set(PENDING_OPTIONS, key, null);
  }
}

async function queueOrVerifyReward(
  ctx,
  {
    eventId,
    optionId,
    reward,
    claimedRewards,
    judgeResult,
    grantsToSettle,
    turn,
    sourceTurnId,
  },
) {
  if (reward.requireOutcome !== true) {
    grantsToSettle.push({ eventId, optionId, reward });
    return;
  }
  const key = rewardKeyOf(eventId, optionId, reward.id);
  if (claimedRewards[key]) return;
  const verdict = judgeResult.verdicts.get(`outcome:${key}`);
  if (verdict) {
    if (verdict.met === true) {
      grantsToSettle.push({ eventId, optionId, reward });
    }
    return;
  }
  await ctx.pluginData.set(PENDING_OPTIONS, key, {
    rewardKey: key,
    eventId,
    ...(optionId ? { optionId } : {}),
    rewardId: reward.id,
    turn,
    stagedTurn: turn,
    turnId: ctx.turnId,
    sourceTurnId,
  });
}

async function applyMatchedRewrittenOption(
  ctx,
  {
    matchedOptionId,
    events,
    selectedOptions,
    nextActive,
    claimedRewards,
    judgeResult,
    armedIds,
    grantsToSettle,
    turn,
    sourceTurnId,
  },
) {
  if (!matchedOptionId || !nextActive[matchedOptionId]) return;
  const matched = nextActive[matchedOptionId];
  const found = findOptionDefinition(events, matched.eventId, matched.id);
  if (!found) return;
  const { event, option } = found;
  const { record: nextSelection } = applyOptionSelection({
    event,
    option,
    selectedOptions,
    activeOptions: nextActive,
    turn,
    sourceTurnId,
  });
  await ctx.pluginData.set(SELECTED_OPTIONS, option.id, nextSelection);
  if (option.payload) {
    const armKey = `${event.id}:${option.id}`;
    await ctx.pluginData.set(ARMED, armKey, {
      eventId: event.id,
      optionId: option.id,
      armedTurn: turn,
      armedTurnId: ctx.turnId,
    });
    armedIds.push(armKey);
  }
  for (const reward of option.rewards ?? []) {
    // When `option.payload` is armed for the next turn, leave `requireOutcome`
    // rewards for `evaluate` to stage against that turn's narration; without a
    // payload, stage `requireOutcome` rewards for verification rather than
    // granting them unverified.
    if (reward.requireOutcome === true && option.payload) continue;
    await queueOrVerifyReward(ctx, {
      eventId: event.id,
      optionId: option.id,
      reward,
      claimedRewards,
      judgeResult,
      grantsToSettle,
      turn,
      sourceTurnId,
    });
  }
}

async function syncEventsAndOptions(
  ctx,
  {
    sortedEvents,
    state,
    semanticEnabled,
    armed,
    revealed,
    selectedOptions,
    claimedRewards,
    nextActive,
    judgeResult,
    armedIds,
    grantsToSettle,
    turn,
    sourceTurnId,
  },
) {
  // First expire any previously unlocked options whose turn budget elapsed.
  for (const [id, entry] of Object.entries(nextActive)) {
    if (
      !entry ||
      (Number.isInteger(entry.expiresAtTurn) && turn >= entry.expiresAtTurn)
    ) {
      delete nextActive[id];
    }
  }

  for (const event of sortedEvents) {
    if (event.enabled === false) {
      for (const opt of event.options ?? []) delete nextActive[opt.id];
      continue;
    }

    const inspected = inspectCondition(event.when, state, {
      scopeId: event.id,
      semanticEnabled,
      deferSemantic: true,
      phase: "audit",
    });
    const eventConditionMet = inspected.status === "true";

    // 5a. Arm semantic story-cue events for 0ms reveal on the next turn.
    if (
      event.payload &&
      eventConditionMet &&
      hasJudgeLeaf(event.when) &&
      event.timing !== "pre-turn" &&
      !armed[event.id] &&
      isEventAvailable(event, revealed[event.id], turn)
    ) {
      const armedRecord = {
        eventId: event.id,
        armedTurn: turn,
        armedTurnId: ctx.turnId,
      };
      armed[event.id] = armedRecord;
      await ctx.pluginData.set(ARMED, event.id, armedRecord);
      armedIds.push(event.id);
    }

    // 5b. Fire pure reward events (no `payload`) directly while still honoring
    //     `requireOutcome: true`.
    if (
      !event.payload &&
      eventConditionMet &&
      isEventAvailable(event, revealed[event.id], turn) &&
      Array.isArray(event.rewards) &&
      event.rewards.length > 0
    ) {
      const previous = revealed[event.id];
      const record = {
        eventId: event.id,
        ...(event.title ? { title: event.title } : {}),
        firstTurn: previous?.firstTurn ?? turn,
        lastTurn: turn,
        lastTurnId: sourceTurnId,
        count: (previous?.count ?? 0) + 1,
      };
      revealed[event.id] = record;
      await ctx.pluginData.set(REVEALED, event.id, record);
      for (const reward of event.rewards) {
        await queueOrVerifyReward(ctx, {
          eventId: event.id,
          optionId: undefined,
          reward,
          claimedRewards,
          judgeResult,
          grantsToSettle,
          turn,
          sourceTurnId,
        });
      }
    }

    // 5c. Sync unlocked hidden options (public view ONLY, never payload/rewards).
    //     Payload events unlock options only once `revealed[event.id]` is set
    //     so armed events never spoil upcoming story turns.
    if (!Array.isArray(event.options) || event.options.length === 0) continue;
    const exclusiveClosed = eventOptionsBlockedByExclusive(
      event,
      selectedOptions,
    );
    const parentActive =
      !exclusiveClosed &&
      (event.payload ? Boolean(revealed[event.id]) : eventConditionMet);

    for (const option of event.options) {
      if (
        exclusiveClosed ||
        (option.once !== false && selectedOptions[option.id])
      ) {
        delete nextActive[option.id];
        continue;
      }
      const optionMet =
        parentActive &&
        (!option.when ||
          inspectCondition(option.when, state, {
            scopeId: `${event.id}:${option.id}`,
            semanticEnabled,
            deferSemantic: true,
            phase: "audit",
          }).status === "true");

      if (optionMet) {
        const existing = nextActive[option.id];
        nextActive[option.id] = existing
          ? {
              ...publicOptionView(option, event, ctx, {
                turn: existing.unlockedTurn ?? turn,
                turnId: existing.unlockedTurnId ?? ctx.turnId,
              }),
              ...(existing.expiresAtTurn !== undefined
                ? { expiresAtTurn: existing.expiresAtTurn }
                : {}),
            }
          : publicOptionView(option, event, ctx, { turn, turnId: ctx.turnId });
      } else if (nextActive[option.id]?.persist !== true) {
        delete nextActive[option.id];
      }
    }
  }
}

async function persistActiveOptionsDiff(ctx, activeOptions, nextActive) {
  const allOptionKeys = new Set([
    ...Object.keys(activeOptions),
    ...Object.keys(nextActive),
  ]);
  for (const key of allOptionKeys) {
    const before = activeOptions[key];
    const after = nextActive[key];
    if (!after && before) {
      await ctx.pluginData.set(ACTIVE_OPTIONS, key, null);
    } else if (after && JSON.stringify(before) !== JSON.stringify(after)) {
      await ctx.pluginData.set(ACTIVE_OPTIONS, key, after);
    }
  }
}

async function writeMessageSurface(
  ctx,
  { sortedNextOptions, claimedRewards, sourceTurnId },
) {
  const messageOptions = sortedNextOptions.map((opt) =>
    toMessageOptionItem(opt, ctx),
  );
  const messageRewards = Object.values(claimedRewards)
    .filter(
      (record) =>
        record &&
        record.announce !== false &&
        (record.sourceTurnId === sourceTurnId || record.turnId === ctx.turnId),
    )
    .sort((a, b) => compareText(a.rewardKey ?? "", b.rewardKey ?? ""))
    .map(toAnnouncementItem);

  if (messageOptions.length > 0 || messageRewards.length > 0) {
    await ctx.pluginData.set(MESSAGE, ctx.turnId, {
      __turnId: ctx.turnId,
      hasOptions: messageOptions.length > 0,
      options: messageOptions,
      hasRewards: messageRewards.length > 0,
      rewards: messageRewards,
    });
  }
}

const emptyAssessResult = () => ({
  outcome: "success",
  value: {
    judged: false,
    armed: [],
    unlockedOptions: [],
    rewardsGranted: [],
  },
});

export default async function handler(ctx) {
  // Only top-level turns assess and mutate hidden trigger state.
  if (ctx.recursionDepth > 0) return emptyAssessResult();

  const { events, eventIds, optionIds } = await loadEvents(ctx);
  if (!events.length) return emptyAssessResult();

  const turn = ctx.logicalTurn ?? 1;
  const sourceTurnId = ctx.execution?.sourceTurnId ?? ctx.turnId;
  const semanticEnabled = ctx.userSettings?.semanticJudge !== false;
  const maxJudged = resolveMaxJudged(ctx.userSettings);

  const revealed = await byKey(ctx, REVEALED);
  const activeOptions = await byKey(ctx, ACTIVE_OPTIONS);
  const selectedOptions = await byKey(ctx, SELECTED_OPTIONS);
  const armed = await byKey(ctx, ARMED);
  const judgments = await byKey(ctx, JUDGMENTS);
  const pendingOptions = await byKey(ctx, PENDING_OPTIONS);
  const claimedRewards = await byKey(ctx, CLAIMED_REWARDS);

  // In `stage: audit`, `ctx.world.dimensions` already overlays post-turn
  // `dimension.update` proposals, and read services overlay post-turn writes.
  const dimensions = ctx.world?.dimensions ?? {};
  const time = ctx.inputs?.worldTime?.value ?? null;
  const narrativeSegments = Array.isArray(ctx.inputs?.narrative?.value)
    ? ctx.inputs.narrative.value
    : [];
  const worldIR = ctx.inputs?.worldIR?.value ?? null;
  const operations = Array.isArray(ctx.inputs?.operations?.value)
    ? ctx.inputs.operations.value
    : [];
  const cueOutput = ctx.inputs?.cue?.value ?? null;

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

  const signals = buildTurnSignals({
    narrativeSegments,
    playerMessage: ctx.playerMessage,
    worldIR,
    dimensions,
    worldTime: time,
    turn,
  });

  const sortedEvents = [...events].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || compareText(a.id, b.id),
  );

  // 1. Collect all semantic judge candidates for this turn.
  const pendingOutcomeEntries = Object.entries(pendingOptions).filter(
    ([, item]) =>
      item &&
      (item.turnId === ctx.turnId ||
        item.sourceTurnId === sourceTurnId ||
        (Number.isInteger(item.stagedTurn) && item.stagedTurn === turn - 1)),
  );
  const candidates = semanticEnabled
    ? collectJudgeCandidates({
        events,
        sortedEvents,
        pendingOutcomeEntries,
        revealed,
        selectedOptions,
        claimedRewards,
        state,
        signals,
        turn,
        locale: ctx.locale,
      })
    : [];

  const activeListBefore = sortActiveOptions(Object.values(activeOptions));
  const shouldMatchRewrittenOption =
    semanticEnabled &&
    !cueOutput?.selectedOption &&
    activeListBefore.length > 0 &&
    Boolean(signals.playerText);

  // 2. Run the concealed judge sub-agent at most once per turn.
  const judgeResult = await runSemanticJudge(ctx, {
    candidates,
    activeOptions: shouldMatchRewrittenOption ? activeListBefore : [],
    signals,
    maxJudged,
  });

  const diagnostics = [...judgeResult.diagnostics];
  await persistJudgeVerdicts(ctx, {
    candidates,
    verdicts: judgeResult.verdicts,
    judgments,
    signals,
    turn,
    sourceTurnId,
    phase: "audit",
  });

  const grantsToSettle = [];
  const armedIds = [];
  const proposals = [];

  // 3. Settle pending `requireOutcome` rewards without deleting on disabled/failed judge.
  await settlePendingOutcomes(ctx, {
    pendingOutcomeEntries,
    events,
    semanticEnabled,
    judgeResult,
    grantsToSettle,
    diagnostics,
  });

  // 4. Handle rewritten / free-typed option match returned by `judge`.
  const nextActive = { ...activeOptions };
  await applyMatchedRewrittenOption(ctx, {
    matchedOptionId: judgeResult.matchedOptionId,
    events,
    selectedOptions,
    nextActive,
    claimedRewards,
    judgeResult,
    armedIds,
    grantsToSettle,
    turn,
    sourceTurnId,
  });

  // 5. Re-evaluate events and options with resolved verdicts.
  await syncEventsAndOptions(ctx, {
    sortedEvents,
    state,
    semanticEnabled,
    armed,
    revealed,
    selectedOptions,
    claimedRewards,
    nextActive,
    judgeResult,
    armedIds,
    grantsToSettle,
    turn,
    sourceTurnId,
  });

  await persistActiveOptionsDiff(ctx, activeOptions, nextActive);

  // 6. Settle rewards granted during `audit`.
  const settled = await grantRewards(ctx, {
    grants: grantsToSettle,
    claimedRewards,
    operations,
    worldIR,
    turn,
    turnId: ctx.turnId,
    sourceTurnId,
  });
  proposals.push(...settled.proposals);
  diagnostics.push(...settled.diagnostics);
  for (const write of settled.claimedWrites) {
    claimedRewards[write.key] = write.value;
    await ctx.pluginData.set(CLAIMED_REWARDS, write.key, write.value);
  }
  for (const [index, text] of settled.narrativeNotes.entries()) {
    await ctx.pluginData.set(NARRATIVE_NOTES, `${ctx.turnId}:${index}`, {
      text,
      turn,
      turnId: ctx.turnId,
    });
  }

  // 7. Write conditional `ui.message` block with `__turnId` so retry anchoring
  //    and live message pruning bind it to the right turn.
  const sortedNextOptions = sortActiveOptions(Object.values(nextActive));
  await writeMessageSurface(ctx, {
    sortedNextOptions,
    claimedRewards,
    sourceTurnId,
  });

  const value = {
    judged: judgeResult.called,
    armed: armedIds,
    unlockedOptions: sortedNextOptions.map((opt) => opt.id),
    rewardsGranted: settled.claimedWrites.map((write) => write.key),
    ...(diagnostics.length ? { diagnostics: [...new Set(diagnostics)] } : {}),
  };
  const result = { outcome: "success", value };
  return proposals.length > 0
    ? withPendingProposals(result, proposals)
    : result;
}
