/**
 * Seats: who plays a session, in which role, and which characters they
 * control. The kernel stores the seats on the session record; these pure
 * helpers derive the bound characters and the current character from them,
 * so the kernel, the prompt builder, the web client and plugins read one rule.
 *
 * Binding is derived when it is read. A seat with `characters: "auto"` binds
 * every character of type `player` that no other seat lists explicitly, in
 * the order of the character list. An explicit list binds the IDs on it that
 * still name a character. Creating a player character therefore needs no seat
 * write: it is bound the next time the seats are read.
 */

import type { TurnAction } from "./actions.js";

/** Who sits in the seat. An AI controller arrives with orchestration. */
export type SeatController = "human" | "empty";

/** The seat's role: what it may do and see. */
export type SeatRole = "player" | "host" | "spectator";

export interface Seat {
  /** Stable within the session; the switch endpoint names the seat by it. */
  readonly id: string;
  readonly controller: SeatController;
  readonly role: SeatRole;
  /** `"auto"` binds every `type: player` character not listed elsewhere. */
  readonly characters: "auto" | readonly string[];
  /** The character this seat acts as; ignored while it is not bound. */
  readonly currentCharacterId?: string;
}

/** The fields of a character the binding rule reads. */
export interface SeatCharacter {
  readonly id: string;
  readonly type: string;
}

/**
 * The IDs of the characters bound to `seat`, in binding order: the order of
 * `characters` for an `"auto"` seat, the order of its list otherwise. IDs that
 * no longer name a character are left out.
 */
export function seatCharacterIds(
  seat: Seat,
  characters: readonly SeatCharacter[],
  seats: readonly Seat[],
): string[] {
  if (seat.characters !== "auto") {
    const existing = new Set(characters.map((character) => character.id));
    return seat.characters.filter((id) => existing.has(id));
  }
  const explicit = new Set<string>();
  for (const other of seats)
    if (other !== seat && other.characters !== "auto")
      for (const id of other.characters) explicit.add(id);
  return characters
    .filter(
      (character) => character.type === "player" && !explicit.has(character.id),
    )
    .map((character) => character.id);
}

/**
 * The character `seat` currently acts as: its `currentCharacterId` while that
 * character is bound, otherwise the first bound character, otherwise none. A
 * deleted current character falls back to the first bound one.
 */
export function currentCharacterOf<C extends SeatCharacter>(
  seat: Seat | undefined,
  characters: readonly C[],
  seats: readonly Seat[],
): C | undefined {
  if (!seat) return undefined;
  const bound = seatCharacterIds(seat, characters, seats);
  const id =
    seat.currentCharacterId !== undefined &&
    bound.includes(seat.currentCharacterId)
      ? seat.currentCharacterId
      : bound[0];
  return id === undefined
    ? undefined
    : characters.find((character) => character.id === id);
}

/** The first human seat with the player role: whose character the story follows. */
export function primarySeat(seats: readonly Seat[]): Seat | undefined {
  return seats.find(
    (seat) => seat.controller === "human" && seat.role === "player",
  );
}

/**
 * The character a plugin follows for this turn: the first existing actor of a
 * player action, otherwise the primary seat's current character, otherwise none.
 * Pass the source turn's actions when processing a detached job.
 */
export function actingCharacterOf<C extends SeatCharacter>(
  actions: readonly TurnAction[],
  characters: readonly C[],
  seats: readonly Seat[],
): C | undefined {
  for (const action of actions) {
    if (action.source !== "player" || !action.actorId) continue;
    const actor = characters.find(
      (character) => character.id === action.actorId,
    );
    if (actor) return actor;
  }
  return currentCharacterOf(primarySeat(seats), characters, seats);
}
