/**
 * The model-facing text of a player's actions: `TurnInput.playerMessage`.
 *
 * One rendering serves the journal row and every runtime that reads the
 * player's message. A single player's ordinary input keeps today's text
 * byte for byte, so single-player prompts and caches do not change. Other
 * submissions name the acting character and the kind, by name and label,
 * never by ID.
 */

import {
  BASE_ACTION_KINDS,
  currentCharacterOf,
  isBaseActionKind,
  modelFacingJson,
  resolveI18nText,
  seatCharacterIds,
  type BaseActionKind,
  type I18nText,
  type Seat,
  type TurnAction,
} from "@covel/shared";
import { loadPrompt, type PromptLoader } from "./prompts-loader.js";

/** The fields of a character the rendering reads. */
export interface RenderActionCharacter {
  readonly id: string;
  readonly type: string;
  readonly name: string;
}

export interface RenderActionsOptions {
  readonly characters: readonly RenderActionCharacter[];
  readonly seats: readonly Seat[];
  /** The session content locale. */
  readonly locale?: string;
  /** Labels of the session's plugin kinds, by wire kind. */
  readonly kindLabels?: ReadonlyMap<string, I18nText>;
  /** Template source; defaults to the framework `prompts/` tree. */
  readonly loadPrompt?: PromptLoader;
}

/** The parsed `prompts/server/action-labels` file of one locale. */
interface ActionLabels {
  readonly withActor: string;
  readonly withoutActor: string;
  readonly kinds: Readonly<Record<BaseActionKind, string>>;
}

const ENTRY = /^([a-z][a-z-]*):[ \t]?(.*)$/;

function parseActionLabels(source: string): ActionLabels {
  const entries = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const match = ENTRY.exec(line.trim());
    if (match?.[1] && match[2] !== undefined)
      entries.set(match[1], match[2].trim());
  }
  const read = (key: string): string => {
    const value = entries.get(key);
    if (!value)
      throw new Error(`prompts/server/action-labels: missing "${key}" entry`);
    return value;
  };
  const kinds = Object.fromEntries(
    BASE_ACTION_KINDS.map((kind) => [kind, read(kind)]),
  ) as Record<BaseActionKind, string>;
  return {
    withActor: read("with-actor"),
    withoutActor: read("without-actor"),
    kinds,
  };
}

/** Fill `{{actor}}`, `{{label}}` and `{{text}}` in one pass. */
function fill(template: string, values: Readonly<Record<string, string>>) {
  return template.replace(
    /\{\{\s*(actor|label|text)\s*\}\}/g,
    (_, key: string) => values[key] ?? "",
  );
}

/**
 * True for a single player's ordinary input: every action comes from one
 * player seat that binds at most one character, is taken as that character
 * (or as none), and is a plain `say`, a slash command or an interaction
 * answer. Its rendering is the texts alone, as before structured input.
 */
function isSinglePlayerInput(
  actions: readonly TurnAction[],
  seats: readonly Seat[],
  characters: readonly RenderActionCharacter[],
): boolean {
  const seatId = actions[0]?.seatId;
  if (seatId === undefined) return true;
  if (actions.some((action) => action.seatId !== seatId)) return false;
  const seat = seats.find((candidate) => candidate.id === seatId);
  if (!seat || seat.role !== "player") return false;
  if (seatCharacterIds(seat, characters, seats).length > 1) return false;
  const current = currentCharacterOf(seat, characters, seats)?.id;
  return actions.every(
    (action) =>
      (action.actorId === undefined || action.actorId === current) &&
      (action.interaction !== undefined ||
        action.kind === "command" ||
        (action.kind === "say" && action.fields === undefined)),
  );
}

function texts(actions: readonly TurnAction[]): string[] {
  return actions
    .map((action) => action.text ?? "")
    .filter((text) => text.length > 0);
}

/**
 * The raw text of a submission, as the player's chat row shows it: the
 * actions' texts, one per line.
 */
export function actionsContent(actions: readonly TurnAction[]): string {
  return texts(actions).join("\n");
}

/**
 * The text part of one action in the labelled rendering, or `undefined` when
 * the action renders nothing. A plugin kind always renders, even without
 * text: its label says what the player did, and its `fields`, as JSON after
 * the text, carry the choice. Base kinds and interaction answers render only
 * their text, so an `advance` or an answer that does not echo adds nothing.
 */
function renderedText(action: TurnAction): string | undefined {
  const text = action.text ?? "";
  if (action.interaction !== undefined || isBaseActionKind(action.kind))
    return text.length > 0 ? text : undefined;
  const fields =
    action.fields !== undefined && Object.keys(action.fields).length > 0
      ? JSON.stringify(modelFacingJson(action.fields))
      : "";
  return [text, fields].filter((part) => part.length > 0).join(" ");
}

/**
 * Render `actions` as the player's message for the model. An action that
 * renders nothing (`advance`, an interaction answer that does not echo) is
 * left out, so an advance-only submission renders as the empty string.
 */
export async function renderActions(
  actions: readonly TurnAction[],
  options: RenderActionsOptions,
): Promise<string> {
  if (isSinglePlayerInput(actions, options.seats, options.characters))
    return actionsContent(actions);
  const rendered = actions.flatMap((action) => {
    const text = renderedText(action);
    return text === undefined ? [] : [{ action, text }];
  });
  if (rendered.length === 0) return "";
  const labels = parseActionLabels(
    await (options.loadPrompt ?? loadPrompt)(
      "server",
      "action-labels",
      options.locale,
    ),
  );
  const names = new Map(
    options.characters.map((character) => [character.id, character.name]),
  );
  return rendered
    .map(({ action, text }) => {
      const label = isBaseActionKind(action.kind)
        ? labels.kinds[action.kind]
        : (resolveI18nText(
            options.kindLabels?.get(action.kind),
            options.locale,
          ) ?? action.kind);
      const actor =
        action.actorId !== undefined ? names.get(action.actorId) : undefined;
      const line = actor
        ? fill(labels.withActor, { actor, label, text })
        : fill(labels.withoutActor, { label, text });
      // A label without text drops the separator the template puts before it.
      return text.length > 0 ? line : line.trimEnd();
    })
    .join("\n");
}
