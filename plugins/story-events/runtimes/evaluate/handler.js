import { localizedText } from "../../lib/conditions.js";
import { selectEvent } from "../../lib/select.js";

// World data from a `visibility: hidden` source lands in this reserved bucket.
const HIDDEN_EVENTS = "_hidden.events";
const REVEALED = "revealed";

function noCue(diagnostics) {
  return {
    outcome: "success",
    value: {
      cue: null,
      cueContext: "No hidden story event this turn.",
      ...(diagnostics.length ? { diagnostics } : {}),
    },
  };
}

function cueResult(event, locale, diagnostics) {
  const payload = localizedText(event.payload, locale);
  const title = event.title ? localizedText(event.title, locale) : undefined;
  return {
    outcome: "success",
    value: {
      cue: { eventId: event.id, ...(title ? { title } : {}), payload },
      cueContext:
        "A hidden story event has just been unlocked by the current state. " +
        "Bring it into this turn naturally, as something that happens in the scene; " +
        "do not mention conditions, triggers, or that it was hidden.\n\n" +
        payload,
      ...(diagnostics.length ? { diagnostics } : {}),
    },
  };
}

export default async function handler(ctx) {
  const events = (await ctx.pluginData.list(HIDDEN_EVENTS))
    .map((row) => row.value)
    .filter((event) => event && typeof event.id === "string" && event.when);
  if (!events.length) return noCue([]);

  const revealedRows = await ctx.pluginData.list(REVEALED);
  const revealed = Object.fromEntries(
    revealedRows.map((row) => [row.key, row.value]),
  );

  // A retried turn re-delivers the cue it already revealed instead of
  // dropping it or firing a second event.
  const sourceTurnId = ctx.execution?.sourceTurnId ?? ctx.turnId;
  const repeat = revealedRows.find(
    (row) => row.value?.lastTurnId === sourceTurnId,
  );
  if (repeat) {
    const event = events.find((item) => item.id === repeat.key);
    if (event) return cueResult(event, ctx.locale, []);
  }

  const session = await ctx.store.getSession();
  const turn = (session?.completedPlayerTurns ?? 0) + 1;
  const state = {
    dimensions: ctx.inputs?.dimensions?.value ?? ctx.world?.dimensions ?? {},
    time: ctx.inputs?.worldTime?.value ?? null,
  };
  const { event, diagnostics } = selectEvent({ events, revealed, state, turn });
  if (!event) return noCue(diagnostics);

  const previous = revealed[event.id];
  // The reveal record is public: it names the event (and its optional public
  // title) but never stores the hidden payload.
  await ctx.pluginData.set(REVEALED, event.id, {
    eventId: event.id,
    ...(event.title ? { title: event.title } : {}),
    firstTurn: previous?.firstTurn ?? turn,
    lastTurn: turn,
    lastTurnId: sourceTurnId,
    count: (previous?.count ?? 0) + 1,
  });
  return cueResult(event, ctx.locale, diagnostics);
}
