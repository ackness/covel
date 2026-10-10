import { describe, expect, it } from "vitest";
import { mentionedNodeIds } from "../lib/mentions.js";

const ids = (text, nodes) => [...mentionedNodeIds(text, nodes)].sort();

describe("mentionedNodeIds", () => {
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
});
