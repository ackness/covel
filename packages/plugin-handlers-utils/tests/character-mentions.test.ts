import { describe, expect, it } from "vitest";
import { mentionedCharacterIds } from "../src/index.js";

const ids = (
  text: string | undefined,
  nodes: Parameters<typeof mentionedCharacterIds>[1],
) => [...mentionedCharacterIds(text, nodes)].sort();

describe("mentionedCharacterIds", () => {
  it("reads a name of a spaced script only where it stands as a word", () => {
    const nodes = [
      { id: "al", name: "Al" },
      { id: "li", name: "Li Wei", aliases: ["Li"] },
    ];
    // "Al" is inside "also" and "Li" inside "like".
    expect(ids("I also like the harbor", nodes)).toEqual([]);
    expect(ids("Ask AL, then find Li.", nodes)).toEqual(["al", "li"]);
    expect(ids("Is this Al's boat?", nodes)).toEqual(["al"]);
  });

  it("reads a name written without spaces anywhere in the text", () => {
    const nodes = [{ id: "lian", name: "阿莲", aliases: ["莲"] }];
    expect(ids("我想找莲问清楚", nodes)).toEqual(["lian"]);
    expect(ids("找Dr.陈和阿莲", nodes)).toEqual(["lian"]);
  });

  it("does not read a short name out of a longer name of another node", () => {
    const nodes = [
      { id: "lian", name: "莲" },
      { id: "town", name: "莲花镇" },
    ];
    expect(ids("明天去莲花镇", nodes)).toEqual(["town"]);
    // Named by itself as well, the short name counts.
    expect(ids("带莲去莲花镇", nodes)).toEqual(["lian", "town"]);
  });

  it("names nothing for an empty message or a node without a name", () => {
    expect(ids("", [{ id: "a", name: "A" }])).toEqual([]);
    expect(ids(undefined, [{ id: "a", name: "A" }])).toEqual([]);
    expect(ids("anything", [{ id: "a" }, { name: "anything" }])).toEqual([]);
  });

  it("does not read a name inside another word or a longer title", () => {
    const nodes = [
      { id: "rin", name: "Rin" },
      { id: "pres", name: "Saegusa", aliases: ["President"] },
      { id: "vice", name: "Shiraishi", aliases: ["Vice President Shiraishi"] },
    ];
    expect(ids("It was spring, during the walk", nodes)).toEqual([]);
    expect(ids("Vice President Shiraishi nodded", nodes)).toEqual(["vice"]);
    expect(ids("The President and Vice President Shiraishi", nodes)).toEqual([
      "pres",
      "vice",
    ]);
  });

  it("prefers the longer title in Chinese and Japanese text", () => {
    const nodes = [
      { id: "chair", name: "三枝遥", aliases: ["会长"] },
      { id: "vice", name: "白石悠真", aliases: ["副会长"] },
      { id: "rin", name: "凛" },
      { id: "kaicho", name: "生徒会長", aliases: ["会長"] },
      { id: "fuku", name: "副会長" },
    ];
    expect(ids("我去找副会长", nodes)).toEqual(["vice"]);
    expect(ids("会长和副会长", nodes)).toEqual(["chair", "vice"]);
    expect(ids("副会長に聞く", nodes)).toEqual(["fuku"]);
    expect(ids("凛と会長", nodes)).toEqual(["kaicho", "rin"]);
  });
});
