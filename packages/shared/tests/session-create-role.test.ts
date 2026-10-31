import { describe, expect, it } from "vitest";
import {
  createSessionRequestSchema,
  defaultSessionSeats,
  seatsSchema,
} from "../src/index.js";
describe("creation role schema", () => {
  it("preserves the omitted player default and creates unbound other roles", () => {
    expect(createSessionRequestSchema.parse({})).toEqual({});
    expect(defaultSessionSeats()).toEqual([
      { id: "main", role: "player", controller: "human", characters: "auto" },
    ]);
    for (const seatRole of ["player", "host", "spectator"] as const) {
      const request = createSessionRequestSchema.parse({
        seatRole,
        autoAdvanceLimit: 0,
      });
      const seats = seatsSchema.parse(defaultSessionSeats(request.seatRole));
      expect(seats[0]).toMatchObject({
        role: seatRole,
        characters: seatRole === "player" ? "auto" : [],
      });
      expect(seats[0]).not.toHaveProperty("currentCharacterId");
    }
  });
  it.each([null, "system", "operator", "HOST", "", 1, {}, []])(
    "rejects %j without accepting a custom seat array",
    (seatRole) => {
      expect(createSessionRequestSchema.safeParse({ seatRole }).success).toBe(
        false,
      );
      expect(createSessionRequestSchema.safeParse({ seats: [] }).success).toBe(
        false,
      );
    },
  );
});
