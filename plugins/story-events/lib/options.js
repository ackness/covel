import {
  compareText,
  labelText,
  resolveI18nText,
} from "@covel/plugin-handlers-utils";
import { normalizeActionText } from "./state-readers.js";

/**
 * Project ONLY the public display fields of an unlocked hidden option.
 * Hidden `payload`, `rewards`, and `when` never enter `active_options`.
 */
export function publicOptionView(option, event, ctx, { turn, turnId }) {
  const locale = ctx.locale;
  const text = resolveI18nText(option.text, locale)?.trim() ?? "";
  const label = option.label
    ? resolveI18nText(option.label, locale)?.trim()
    : undefined;
  const hint = option.hint
    ? resolveI18nText(option.hint, locale)?.trim()
    : undefined;
  return {
    id: option.id,
    eventId: event.id,
    text,
    ...(label ? { label } : {}),
    ...(hint ? { hint } : {}),
    priority: event.priority ?? 0,
    unlockedTurn: turn,
    unlockedTurnId: turnId,
    ...(Number.isInteger(option.expiresAfterTurns)
      ? { expiresAtTurn: turn + option.expiresAfterTurns }
      : {}),
    persist: option.persist === true,
    once: option.once !== false,
    exclusive: event.exclusive === true,
  };
}

/** Find a hidden option definition inside `_hidden.events` / `_hidden.planned`. */
export function findOptionDefinition(events, eventId, optionId) {
  const event = events.find((item) => item.id === eventId);
  if (!event || !Array.isArray(event.options)) return null;
  const option = event.options.find((item) => item.id === optionId);
  return option ? { event, option } : null;
}

/**
 * Record an option selection into `selectedOptions` and remove the option
 * (plus exclusive siblings when `event.exclusive` is true) from `activeOptions`.
 * Returns the IDs removed from `activeOptions`.
 */
export function applyOptionSelection({
  event,
  option,
  selectedOptions,
  activeOptions,
  turn,
  sourceTurnId,
}) {
  const prev = selectedOptions[option.id];
  const record = {
    optionId: option.id,
    eventId: event.id,
    firstTurn: prev?.firstTurn ?? turn,
    lastTurn: turn,
    lastTurnId: sourceTurnId,
    count: (prev?.count ?? 0) + 1,
  };
  selectedOptions[option.id] = record;

  const removedActiveIds = [];
  if (option.once !== false && activeOptions[option.id]) {
    delete activeOptions[option.id];
    removedActiveIds.push(option.id);
  }
  if (event.exclusive === true) {
    for (const sibling of Object.values(activeOptions)) {
      if (sibling?.eventId === event.id && sibling.id !== option.id) {
        delete activeOptions[sibling.id];
        removedActiveIds.push(sibling.id);
      }
    }
  }
  return { record, removedActiveIds };
}

/** Deterministic exact-match lookup of an active option against player input. */
export function findExactSelectedOption(activeOptions, playerMessage) {
  const target = normalizeActionText(playerMessage);
  if (!target) return null;
  const sorted = sortActiveOptions(Object.values(activeOptions ?? {}));
  for (const option of sorted) {
    if (normalizeActionText(option.text) === target) return option;
  }
  return null;
}

export function sortActiveOptions(options) {
  return [...options]
    .filter((option) => option && typeof option.id === "string" && option.text)
    .sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        compareText(a.eventId ?? "", b.eventId ?? "") ||
        compareText(a.id, b.id),
    );
}

/** Format an unlocked option for `ui/hidden-unlocks-block.json`. */
export function toMessageOptionItem(option, ctx) {
  return {
    id: option.id,
    text: option.text,
    hint: option.hint ?? "",
    label: option.label || labelText(ctx, "Hidden action"),
    selectionGroup: `story-events:${option.id}`,
  };
}

/**
 * Pipeline handler for `ui.slot@1` (`stage.choices@1`, order 50).
 * Prepends unlocked hidden options ahead of `guide`'s choices while keeping
 * `previous.turnId`, `scene`, `recap`, and `decision` intact.
 */
export function mergeStageChoices(previous, activeOptionRows, ctx) {
  const active = sortActiveOptions(activeOptionRows.map((row) => row.value));
  if (active.length === 0) return previous ?? null;

  const hiddenChoices = active.map((option) => ({
    id: `hidden:${option.id}`,
    text: option.text,
    label: option.label || labelText(ctx, "Hidden action"),
  }));
  const hiddenIds = new Set(hiddenChoices.map((choice) => choice.id));
  const existingChoices = Array.isArray(previous?.choices)
    ? previous.choices.filter((choice) => !hiddenIds.has(choice.id))
    : [];
  const merged = [...hiddenChoices, ...existingChoices].slice(0, 64);

  if (previous && typeof previous === "object") {
    return {
      ...previous,
      choices: merged,
    };
  }
  return { choices: merged };
}
