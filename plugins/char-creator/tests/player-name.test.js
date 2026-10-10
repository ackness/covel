import { describe, expect, it } from "vitest";
import { takenNameKeys, validatePlayerName } from "../lib/player-name.js";

const characters = [
  {
    id: "char-tomas-vale",
    name: "Tomas Vale",
    aliases: ["Tomas"],
    type: "npc",
  },
  {
    id: "char-ana",
    name: "阿娜・貝爾",
    aliases: ["The Ferryman", "Ｏ’Neil"],
    type: "companion",
  },
  { id: "char-old", name: "Wren", aliases: ["Birdie"], type: "player" },
];
const data = { taken: takenNameKeys(characters) };
const en = { locale: "en" };

describe("player name validator", () => {
  it.each([
    ["an alias", "Tomas"],
    ["a full name", "Tomas Vale"],
    ["another letter case", "tOMAS"],
    ["full-width letters", "Ｔｏｍａｓ"],
    ["extra white space", "  Tomas   Vale "],
    ["another middle dot", "阿娜·貝爾"],
    ["a dropped article", "ferryman"],
    ["another apostrophe", "o'neil"],
  ])("refuses %s of a character of the world", (_case, characterName) => {
    expect(validatePlayerName({ characterName }, data, en)).toEqual({
      field: "characterName",
      message: `The name "${characterName.trim()}" already belongs to a character of this world. Choose another name.`,
    });
  });

  it.each(["Tom", "Vale", "Tomasz", "Wren", "Birdie"])(
    "accepts the free name %s",
    (characterName) => {
      expect(validatePlayerName({ characterName }, data, en)).toBeUndefined();
    },
  );

  it("answers in the session's language", () => {
    const text =
      'The name "{name}" already belongs to a character of this world. Choose another name.';
    expect(
      validatePlayerName({ characterName: "Tomas" }, data, {
        locale: "zh-CN",
        messages: { translations: { [text]: "“{name}”已有人使用。" } },
      }),
    ).toEqual({ field: "characterName", message: "“Tomas”已有人使用。" });
  });

  it("accepts the answer of a form that carries no name list", () => {
    expect(
      validatePlayerName({ characterName: "Tomas" }, undefined, en),
    ).toBeUndefined();
  });
});
