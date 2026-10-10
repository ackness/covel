import { pickLocaleText, resolveI18nText } from "@covel/plugin-handlers-utils";
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
const cueInstruction = (locale) =>
  pickLocaleText(
    locale,
    "当前状态刚刚解锁了一个隐藏的故事事件。把它自然地带进本回合，写成场景里发生的事；不要提到条件、触发器，也不要提到它曾被隐藏。",
    "A hidden story event has just been unlocked by the current state. Bring it into this turn naturally, as something that happens in the scene; do not mention conditions, triggers, or that it was hidden.",
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

function cueResult(event, locale, diagnostics, book, reminder = false) {
  const payload = resolveI18nText(event.payload, locale) ?? "";
  const title = event.title ? resolveI18nText(event.title, locale) : undefined;
  const instruction = reminder
    ? reminderInstruction(locale)
    : cueInstruction(locale);
  return {
    outcome: "success",
    value: {
      cue: {
        eventId: event.id,
        ...(title ? { title } : {}),
        payload,
        ...(reminder ? { reminder: true } : {}),
      },
      cueContext: `${instruction}\n\n${payload}`,
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
  const turn = ctx.logicalTurn ?? 1;
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
  const repeatedReminder = revealedRows.find(
    (row) => row.value?.reminderTurnId === sourceTurnId,
  );
  if (repeatedReminder) {
    const event = events.find((item) => item.id === repeatedReminder.key);
    if (event) return cueResult(event, ctx.locale, [], book, true);
  }

  const state = {
    dimensions: ctx.inputs?.dimensions?.value ?? ctx.world?.dimensions ?? {},
    time: ctx.inputs?.worldTime?.value ?? null,
  };
  const { event, diagnostics } = selectEvent({ events, revealed, state, turn });
  if (!event) {
    // A new event takes the turn; without one, last turn's event is given a
    // second time, and only this once.
    const due = revealedRows.find(
      (row) => row.value?.lastTurn === turn - 1 && !row.value.reminderTurnId,
    );
    const last = due && events.find((item) => item.id === due.key);
    if (!last) return noCue(diagnostics, book);
    await ctx.pluginData.set(REVEALED, due.key, {
      ...due.value,
      reminderTurnId: sourceTurnId,
    });
    return cueResult(last, ctx.locale, diagnostics, book, true);
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
  return cueResult(
    event,
    ctx.locale,
    diagnostics,
    ledger(planned, { ...revealed, [event.id]: record }, turn, ctx.locale),
  );
}
