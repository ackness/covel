/**
 * Seats on the session record: the Zod schema the store and the API validate
 * them with, and the invariants every write keeps. The `Seat` type and the
 * binding helpers live in the author SDK (`@covel/plugin-handlers-utils`).
 */

import { z } from "zod";
import type { Seat } from "@covel/plugin-handlers-utils";

const seatShape = z
  .object({
    id: z.string().trim().min(1),
    controller: z.enum(["human", "empty"]),
    role: z.enum(["player", "host", "spectator"]),
    characters: z.union([z.literal("auto"), z.array(z.string().min(1))]),
    currentCharacterId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Throw when `seats` breaks an invariant: seat IDs are unique, at most one
 * seat binds `"auto"`, and an explicit character ID is listed once, in one
 * seat. An `"auto"` seat leaves out the IDs listed elsewhere, so it never
 * shares a character with an explicit seat.
 */
export function assertSeatsValid(seats: readonly Seat[]): void {
  const seatIds = new Set<string>();
  const listed = new Map<string, string>();
  let autoSeat: string | undefined;
  for (const seat of seats) {
    if (seatIds.has(seat.id)) throw new Error(`Duplicate seat id: ${seat.id}`);
    seatIds.add(seat.id);
    if (seat.characters === "auto") {
      if (autoSeat !== undefined)
        throw new Error(
          `Seats ${autoSeat} and ${seat.id} both bind "auto"; at most one seat may`,
        );
      autoSeat = seat.id;
      continue;
    }
    for (const characterId of seat.characters) {
      const owner = listed.get(characterId);
      if (owner !== undefined)
        throw new Error(
          owner === seat.id
            ? `Seat ${seat.id} lists character ${characterId} twice`
            : `Character ${characterId} is bound to seats ${owner} and ${seat.id}`,
        );
      listed.set(characterId, seat.id);
    }
  }
}

/** A session's seats, invariants included. */
export const seatsSchema: z.ZodType<Seat[]> = z
  .array(seatShape)
  .superRefine((seats, ctx) => {
    try {
      assertSeatsValid(seats);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

/** The seats of a new session: one human player who controls every player character. */
export function defaultSessionSeats(): Seat[] {
  return [
    { id: "main", controller: "human", role: "player", characters: "auto" },
  ];
}
