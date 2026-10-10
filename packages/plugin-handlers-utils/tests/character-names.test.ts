import { describe, expect, it } from "vitest";
import {
  characterNameKey,
  describeUnresolvedCharacter,
  findCharacterAliasConflict,
  mergeCharacterAliases,
  resolveCharacter,
} from "../src/index.js";

const cast = [
  {
    id: "npc-ysolde",
    name: "Keeper Ysolde",
    aliases: ["Ysolde", "the Keeper"],
  },
  { id: "npc-brannoc", name: "布兰诺克・黑尔", aliases: ["布兰", "老黑尔"] },
  { id: "npc-mina", name: "Dr. Mina Park" },
  { id: "npc-june", name: "Mina Okafor" },
  { id: "npc-chen", name: "陈远山", aliases: ["陈议长"] },
];

describe("characterNameKey", () => {
  it.each([
    ["  Keeper   Ysolde ", "keeper ysolde"],
    ["ＫＥＥＰＥＲ　Ｙｓｏｌｄｅ", "keeper ysolde"],
    ["“Keeper Ysolde”", "keeper ysolde"],
    ["「布兰诺克・黑尔」", "布兰诺克·黑尔"],
    ["布兰诺克·黑尔", "布兰诺克·黑尔"],
    ["布兰诺克•黑尔", "布兰诺克·黑尔"],
    ["The Keeper", "keeper"],
    ["O’Brien", "o'brien"],
  ])("folds %s to %s", (written, key) => {
    expect(characterNameKey(written)).toBe(key);
  });

  it("keeps titles, honorifics and particles: they can tell two people apart", () => {
    expect(characterNameKey("Dr. Park")).not.toBe(characterNameKey("Mr. Park"));
    expect(characterNameKey("陈先生")).not.toBe(characterNameKey("陈小姐"));
    expect(characterNameKey("老黑尔")).not.toBe(characterNameKey("黑尔"));
    expect(characterNameKey("Theo")).toBe("theo");
  });
});

describe("resolveCharacter", () => {
  it("finds by id, then name, then alias, in any spelling the key folds", () => {
    expect(resolveCharacter(cast, "npc-mina")).toMatchObject({
      status: "found",
      matchedBy: "id",
      character: { id: "npc-mina" },
    });
    expect(resolveCharacter(cast, "布兰诺克·黑尔")).toMatchObject({
      matchedBy: "name",
      character: { id: "npc-brannoc" },
    });
    expect(resolveCharacter(cast, "THE  KEEPER")).toMatchObject({
      matchedBy: "alias",
      character: { id: "npc-ysolde" },
    });
  });

  it("prefers the character that has the text as its name over one that has it as an alias", () => {
    const withClash = [
      ...cast,
      { id: "npc-other", name: "Maud", aliases: ["陈远山"] },
    ];
    expect(resolveCharacter(withClash, "陈远山")).toMatchObject({
      matchedBy: "name",
      character: { id: "npc-chen" },
    });
  });

  it("reports a name or an alias that two characters have as ambiguous", () => {
    const twins = [
      ...cast,
      { id: "npc-maud", name: "Maud", aliases: ["The Keeper"] },
      { id: "npc-maud-2", name: "maud" },
    ];
    expect(resolveCharacter(twins, "the keeper")).toEqual({
      status: "ambiguous",
      candidates: [twins[0], twins[5]],
    });
    expect(resolveCharacter(twins, "Maud")).toMatchObject({
      status: "ambiguous",
      candidates: [{ id: "npc-maud" }, { id: "npc-maud-2" }],
    });
  });

  it("does not resolve a part of a name, a misspelling or a shared family name", () => {
    for (const query of ["Mina", "Ysolda", "陈", "Park", "黑尔"]) {
      expect(resolveCharacter(cast, query).status).toBe("missing");
    }
  });

  it("lists the closest characters on a miss, best first, and none when nothing is close", () => {
    const misspelt = resolveCharacter(cast, "Keeper Ysolda");
    expect(misspelt).toMatchObject({ status: "missing" });
    expect(
      misspelt.status === "missing" && misspelt.closest.map((c) => c.id),
    ).toEqual(["npc-ysolde"]);
    const shared = resolveCharacter(cast, "Mina");
    expect(
      shared.status === "missing" && shared.closest.map((c) => c.id),
    ).toEqual(["npc-mina", "npc-june"]);
    expect(resolveCharacter(cast, "Zephyrine")).toEqual({
      status: "missing",
      closest: [],
    });
  });

  it("with partial, returns the single character whose name contains the query, and no one when two do", () => {
    expect(
      resolveCharacter(cast, "mina park", { partial: true }),
    ).toMatchObject({ matchedBy: "partial", character: { id: "npc-mina" } });
    expect(resolveCharacter(cast, "黑尔", { partial: true })).toMatchObject({
      character: { id: "npc-brannoc" },
    });
    expect(resolveCharacter(cast, "Mina", { partial: true }).status).toBe(
      "missing",
    );
  });

  it("treats text with no letters as a miss", () => {
    expect(resolveCharacter(cast, " “” ")).toEqual({
      status: "missing",
      closest: [],
    });
  });
});

describe("aliases of one character", () => {
  it("adds new names in order and leaves out the name itself and repeats", () => {
    expect(
      mergeCharacterAliases(
        "Keeper Ysolde",
        ["Ysolde"],
        [" the  Keeper ", "ysolde", "KEEPER YSOLDE", "", "伊索德"],
      ),
    ).toEqual(["Ysolde", "the Keeper", "伊索德"]);
  });

  it("finds the character that already has an alias as a name or an alias", () => {
    expect(
      findCharacterAliasConflict(cast, {
        id: "npc-new",
        name: "Old Woman",
        aliases: ["Granny", "ＹＳＯＬＤＥ"],
      }),
    ).toEqual({ alias: "ＹＳＯＬＤＥ", owner: cast[0] });
    expect(
      findCharacterAliasConflict(cast, {
        id: "npc-new",
        name: "Old Woman",
        aliases: ["dr. mina park"],
      })?.owner.id,
    ).toBe("npc-mina");
    // A character's own names are no conflict with itself.
    expect(findCharacterAliasConflict(cast, cast[0]!)).toBeUndefined();
  });
});

describe("describeUnresolvedCharacter", () => {
  it("names the closest characters with their aliases and no ids", () => {
    const resolution = resolveCharacter(cast, "Ysolda");
    if (resolution.status === "found") throw new Error("unexpected match");
    expect(describeUnresolvedCharacter("Ysolda", resolution, cast)).toBe(
      'Character "Ysolda" not found. Closest known names: Keeper Ysolde (aka Ysolde, the Keeper). If it is one of them, use that name.',
    );
  });

  it("lists the ids of an ambiguous name, the only way to tell them apart", () => {
    const twins = [
      { id: "npc-a", name: "Maud" },
      { id: "npc-b", name: "maud" },
    ];
    const resolution = resolveCharacter(twins, "Maud");
    if (resolution.status === "found") throw new Error("unexpected match");
    expect(describeUnresolvedCharacter("Maud", resolution, twins)).toBe(
      '"Maud" names 2 characters: Maud [npc-a]; maud [npc-b]. Pass the id of the one you mean.',
    );
  });
});
