import { describe, expect, it } from "vitest";
import {
  actingCharacterOf,
  currentCharacterOf,
  primarySeat,
  seatCharacterIds,
  type Seat,
  type TurnAction,
} from "../src/index.js";

const characters = [
  { id: "ada", type: "player" },
  { id: "guide", type: "npc" },
  { id: "lin", type: "player" },
  { id: "kai", type: "player" },
];

const auto = (overrides: Partial<Seat> = {}): Seat => ({
  id: "main",
  controller: "human",
  role: "player",
  characters: "auto",
  ...overrides,
});

describe("seatCharacterIds", () => {
  it("binds every player character to an auto seat, in character order", () => {
    const seat = auto();
    expect(seatCharacterIds(seat, characters, [seat])).toEqual([
      "ada",
      "lin",
      "kai",
    ]);
  });

  it("binds the IDs of an explicit list that still name a character, in list order", () => {
    const seat = auto({ characters: ["kai", "gone", "guide"] });
    expect(seatCharacterIds(seat, characters, [seat])).toEqual([
      "kai",
      "guide",
    ]);
  });

  it("leaves IDs bound explicitly elsewhere out of an auto seat", () => {
    const main = auto();
    const second = auto({ id: "second", characters: ["lin"] });
    const seats = [main, second];
    expect(seatCharacterIds(main, characters, seats)).toEqual(["ada", "kai"]);
    expect(seatCharacterIds(second, characters, seats)).toEqual(["lin"]);
  });

  it("binds nothing when the session has no player character", () => {
    const seat = auto();
    expect(
      seatCharacterIds(seat, [{ id: "guide", type: "npc" }], [seat]),
    ).toEqual([]);
  });
});

describe("currentCharacterOf", () => {
  it.each<[string, Seat, string | undefined]>([
    ["the first bound character without a choice", auto(), "ada"],
    [
      "the chosen character while it is bound",
      auto({ currentCharacterId: "lin" }),
      "lin",
    ],
    [
      "the first bound character when the chosen one was deleted",
      auto({ currentCharacterId: "gone" }),
      "ada",
    ],
    [
      "the first bound character when the chosen one is not bound",
      auto({ currentCharacterId: "guide" }),
      "ada",
    ],
    [
      "the chosen character of an explicit list",
      auto({ characters: ["guide", "kai"], currentCharacterId: "kai" }),
      "kai",
    ],
    [
      "nothing for a seat that binds nothing",
      auto({ characters: [] }),
      undefined,
    ],
  ])("returns %s", (_label, seat, expected) => {
    expect(currentCharacterOf(seat, characters, [seat])?.id).toBe(expected);
  });

  it("returns the character record itself, and nothing without a seat", () => {
    const seat = auto({ currentCharacterId: "kai" });
    expect(currentCharacterOf(seat, characters, [seat])).toBe(characters[3]);
    expect(currentCharacterOf(undefined, characters, [])).toBeUndefined();
  });

  it("does not pick a character another seat lists explicitly", () => {
    const main = auto({ currentCharacterId: "lin" });
    const seats = [main, auto({ id: "second", characters: ["lin"] })];
    expect(currentCharacterOf(main, characters, seats)?.id).toBe("ada");
  });
});

describe("primarySeat", () => {
  it("is the first human seat with the player role", () => {
    const host = auto({ id: "host", role: "host" });
    const empty = auto({ id: "empty", controller: "empty", characters: [] });
    const player = auto({ id: "player", characters: [] });
    expect(primarySeat([host, empty, player])).toBe(player);
    expect(primarySeat([host, empty])).toBeUndefined();
    expect(primarySeat([])).toBeUndefined();
  });
});

describe("actingCharacterOf", () => {
  const action = (
    actorId: string,
    source: TurnAction["source"] = "player",
  ): TurnAction => ({ seatId: "main", kind: "act", source, actorId });

  it("returns the first existing actor named by a player action", () => {
    expect(
      actingCharacterOf(
        [
          action("gone"),
          action("guide", "system"),
          action("lin"),
          action("kai"),
        ],
        characters,
        [auto()],
      ),
    ).toBe(characters[2]);
    expect(actingCharacterOf([action("guide")], characters, [])).toBe(
      characters[1],
    );
  });

  it("ignores missing actors and system actions and falls back to the primary seat", () => {
    const seats = [auto({ currentCharacterId: "kai" })];
    expect(
      actingCharacterOf(
        [action("gone"), action("lin", "system")],
        characters,
        seats,
      ),
    ).toBe(characters[3]);
    expect(actingCharacterOf([], characters, seats)).toBe(characters[3]);
  });

  it("returns nothing without a seat or a bound character", () => {
    expect(actingCharacterOf([], characters, [])).toBeUndefined();
    expect(
      actingCharacterOf([], characters, [auto({ characters: [] })]),
    ).toBeUndefined();
    expect(actingCharacterOf([], [], [auto()])).toBeUndefined();
  });

  it("follows changes to the current character", () => {
    expect(
      actingCharacterOf([], characters, [auto({ currentCharacterId: "lin" })])
        ?.id,
    ).toBe("lin");
    expect(
      actingCharacterOf([], characters, [auto({ currentCharacterId: "kai" })])
        ?.id,
    ).toBe("kai");
  });
});
