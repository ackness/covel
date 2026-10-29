/**
 * Actions: what a player submits in one turn. A submission is a list of
 * actions, each taken from one seat with one kind (`say`, `act`, a plugin's
 * own kind, ...). The host checks every action against the seat's role and
 * fills in the defaults before a runtime reads it, so a plugin never derives
 * the seat or the acting character itself.
 */

import type { JsonValue } from "./types.js";

/** The interaction an action answers: a committed form, choice or confirmation. */
export type TurnActionInteraction = {
  /** The turn whose message carries the interaction. */
  readonly turnId: string;
  readonly interactionId: string;
  readonly type: "form" | "choice" | "confirmation";
};

/**
 * One resolved action of a turn. `seatId` and `source` are always set;
 * `actorId` is set whenever the kind takes an actor and the seat binds a
 * character. A type alias, not an interface, so an action is a `JsonValue`.
 */
export type TurnAction = {
  /** The seat the action was taken from. */
  readonly seatId: string;
  /**
   * A base kind (`say`, `act`, `narrate`, `direct`, `advance`, `command`) or
   * a plugin kind, written `<pluginId>/<name>`.
   */
  readonly kind: string;
  /** The character the action is taken as; absent for kinds without an actor. */
  readonly actorId?: string;
  /**
   * What the player wrote. For an interaction answer, the answer's filled
   * narrative (empty when the interaction does not echo it).
   */
  readonly text?: string;
  /** The kind's structured fields, or an interaction answer's values. */
  readonly fields?: Readonly<Record<string, JsonValue>>;
  /** Present when the action answers a committed interaction. */
  readonly interaction?: TurnActionInteraction;
  /** `player` for a submission; `system` is reserved for automatic rounds. */
  readonly source: "player" | "system";
};
