import { describe, expect, it } from "vitest";
import {
  assertSeatsValid,
  defaultSessionSeats,
  seatsSchema,
  type Seat,
} from "../src/index.js";

const seat = (overrides: Partial<Seat> = {}): Seat => ({
  id: "main",
  controller: "human",
  role: "player",
  characters: "auto",
  ...overrides,
});

describe("assertSeatsValid", () => {
  it.each<[string, Seat[]]>([
    ["the default seat", defaultSessionSeats()],
    ["no seat", []],
    [
      "an auto seat beside explicit seats",
      [
        seat(),
        seat({ id: "b", characters: ["lin"] }),
        seat({ id: "c", controller: "empty", characters: ["kai"] }),
      ],
    ],
    [
      "a current character outside the binding (it falls back when read)",
      [seat({ currentCharacterId: "gone" })],
    ],
  ])("accepts %s", (_label, seats) => {
    expect(() => assertSeatsValid(seats)).not.toThrow();
  });

  it.each<[string, Seat[], RegExp]>([
    ["two auto seats", [seat(), seat({ id: "b" })], /both bind "auto"/],
    [
      "a character listed in two seats",
      [seat({ characters: ["lin"] }), seat({ id: "b", characters: ["lin"] })],
      /bound to seats main and b/,
    ],
    [
      "a character listed twice in one seat",
      [seat({ characters: ["lin", "lin"] })],
      /lists character lin twice/,
    ],
    [
      "a repeated seat id",
      [seat({ characters: [] }), seat({ characters: [] })],
      /Duplicate seat id/,
    ],
  ])("rejects %s", (_label, seats, message) => {
    expect(() => assertSeatsValid(seats)).toThrow(message);
  });
});

describe("seatsSchema", () => {
  it("parses the default seats", () => {
    expect(seatsSchema.parse(defaultSessionSeats())).toEqual([
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ]);
  });

  it("rejects an unknown controller, an unknown field and a broken invariant", () => {
    expect(
      seatsSchema.safeParse([{ ...seat(), controller: "ai" }]).success,
    ).toBe(false);
    expect(seatsSchema.safeParse([{ ...seat(), extra: true }]).success).toBe(
      false,
    );
    expect(seatsSchema.safeParse([seat(), seat({ id: "b" })]).success).toBe(
      false,
    );
  });

  it("hands out a fresh default each time", () => {
    expect(defaultSessionSeats()).not.toBe(defaultSessionSeats());
  });
});
