import { localizedText } from "../../lib/conditions.js";
import { selectEvent } from "../../lib/select.js";

// World data from a `visibility: hidden` source lands in this reserved bucket.
const HIDDEN_EVENTS = "_hidden.events";
// Events planned during play by other runtimes (see the intake runtime).
const PLANNED = "_hidden.planned";
const REVEALED = "revealed";
// The value of `cueContext` in a turn with no event. The narrative prompts
// name this text in both languages, so it is a marker and is not translated.
const NO_CUE = "No hidden story event this turn.";
// What the narrative is told to do with a cue: an instruction, so English,
// and Chinese for a Simplified Chinese session.
const CUE_INSTRUCTION = {
  "en-US":
    "A hidden story event has just been unlocked by the current state. Bring it into this turn naturally, as something that happens in the scene; do not mention conditions, triggers, or that it was hidden.",
  "zh-CN":
    "当前状态刚刚解锁了一个隐藏的故事事件。把它自然地带进本回合，写成场景里发生的事；不要提到条件、触发器，也不要提到它曾被隐藏。",
};

function storedEvents(rows) {
  return rows
    .map((row) => row.value)
    .filter((event) => event && typeof event.id === "string" && event.when);
}

/**
 * What planners may know: fired events and pending planned events, by ID and
 * public title only. Pending world-authored events stay out of it entirely.
 */
function ledger(planned, revealed, turn, locale) {
  const title = (value) =>
    value ? { title: localizedText(value, locale) } : {};
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

function noCue(diagnostics, book) {
  return {
    outcome: "success",
    value: {
      cue: null,
      cueContext: NO_CUE,
      ledger: book,
      ...(diagnostics.length ? { diagnostics } : {}),
    },
  };
}

function cueResult(event, locale, diagnostics, book) {
  const payload = localizedText(event.payload, locale);
  const title = event.title ? localizedText(event.title, locale) : undefined;
  return {
    outcome: "success",
    value: {
      cue: { eventId: event.id, ...(title ? { title } : {}), payload },
      cueContext: `${localizedText(CUE_INSTRUCTION, locale)}\n\n${payload}`,
      ledger: book,
      ...(diagnostics.length ? { diagnostics } : {}),
    },
  };
}

export default async function handler(ctx) {
  const authored = storedEvents(await ctx.pluginData.list(HIDDEN_EVENTS));
  const authoredIds = new Set(authored.map((event) => event.id));
  // Authored events win an ID clash; intake already refuses one.
  const planned = storedEvents(await ctx.pluginData.list(PLANNED)).filter(
    (event) => !authoredIds.has(event.id),
  );
  const events = [...authored, ...planned];

  const revealedRows = await ctx.pluginData.list(REVEALED);
  const revealed = Object.fromEntries(
    revealedRows.map((row) => [row.key, row.value]),
  );
  const session = await ctx.store.getSession();
  const turn = (session?.completedPlayerTurns ?? 0) + 1;
  const book = ledger(planned, revealed, turn, ctx.locale);
  if (!events.length) return noCue([], book);

  // A retried turn re-delivers the cue it already revealed instead of
  // dropping it or firing a second event.
  const sourceTurnId = ctx.execution?.sourceTurnId ?? ctx.turnId;
  const repeat = revealedRows.find(
    (row) => row.value?.lastTurnId === sourceTurnId,
  );
  if (repeat) {
    const event = events.find((item) => item.id === repeat.key);
    if (event) return cueResult(event, ctx.locale, [], book);
  }

  const state = {
    dimensions: ctx.inputs?.dimensions?.value ?? ctx.world?.dimensions ?? {},
    time: ctx.inputs?.worldTime?.value ?? null,
  };
  const { event, diagnostics } = selectEvent({ events, revealed, state, turn });
  if (!event) return noCue(diagnostics, book);

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
  return cueResult(
    event,
    ctx.locale,
    diagnostics,
    ledger(planned, { ...revealed, [event.id]: record }, turn, ctx.locale),
  );
}
