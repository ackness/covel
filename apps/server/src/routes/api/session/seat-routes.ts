/**
 * Seat control:
 *
 *   PATCH /api/sessions/:id/seats/:seatId   body: { currentCharacterId }
 *
 * Switches the character a human seat acts as. The character must be bound to
 * that seat (binding is derived from the seats and the character list, see
 * `seatCharacterIds`). The write runs under the session lock, so it lands
 * between turns, and applies from the next turn. It returns the session's
 * seats; no event is published.
 */

import type { Hono } from "hono";
import { z } from "zod";
import { assertSeatsValid, seatCharacterIds } from "@covel/shared";
import { errorBody, readJsonBody } from "../../../api-error.js";
import { rateLimiter } from "../../../middleware/rate-limit.js";
import { withLockedSessionMutation } from "./locked-mutation.js";
import type { SessionRouteEnv } from "./route-env.js";
import { resolveSessionParam } from "./session-guard.js";

const seatPatchSchema = z
  .object({ currentCharacterId: z.string().trim().min(1) })
  .strict();

export function registerSessionSeatRoutes(routes: Hono<SessionRouteEnv>): void {
  routes.patch("/:id/seats/:seatId", rateLimiter({ max: 60 }), async (c) => {
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const parsed = await readJsonBody<unknown>(c);
    if (parsed instanceof Response) return parsed;
    const body = seatPatchSchema.safeParse(parsed.body);
    if (!body.success) {
      return c.json(
        errorBody("Body must be { currentCharacterId: string }", {
          code: "invalid_body",
        }),
        400,
      );
    }
    const { currentCharacterId } = body.data;
    const seatId = c.req.param("seatId");
    const store = c.get("store");
    return withLockedSessionMutation({
      c,
      store,
      sessionLock: c.get("sessionLock"),
      sessionId: guard.session.id,
      expectedSession: guard.session,
      allowedStatuses: ["active", "paused"],
      mutate: async (live) => {
        const seat = live.seats.find((candidate) => candidate.id === seatId);
        if (!seat) {
          return c.json(
            errorBody(`Seat not found: ${seatId}`, { code: "seat_not_found" }),
            404,
          );
        }
        if (seat.controller !== "human") {
          return c.json(
            errorBody(`Seat ${seatId} has no human controller`, {
              code: "seat_not_human",
            }),
            409,
          );
        }
        const characters = await store.listCharacters(live.id);
        if (
          !seatCharacterIds(seat, characters, live.seats).includes(
            currentCharacterId,
          )
        ) {
          return c.json(
            errorBody(
              `Character ${currentCharacterId} is not bound to seat ${seatId}`,
              { code: "seat_character_unbound" },
            ),
            409,
          );
        }
        const seats = live.seats.map((candidate) =>
          candidate === seat ? { ...candidate, currentCharacterId } : candidate,
        );
        assertSeatsValid(seats);
        await store.updateSession(live.id, {
          seats,
          updatedAt: new Date().toISOString(),
        });
        return c.json({ seats });
      },
    });
  });
}
