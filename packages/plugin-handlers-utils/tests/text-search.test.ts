import { describe, expect, it } from "vitest";
import { rankTexts, searchExcerpt, searchTerms } from "../src/text-search.js";

describe("searchTerms", () => {
  it("splits unspaced text into pairs and keeps words whole", () => {
    expect(searchTerms("守门人 Alice 的 lanterns")).toEqual([
      "守门",
      "门人",
      "alice",
      "的",
      "lantern",
    ]);
  });
});

describe("rankTexts", () => {
  const texts = [
    "The guard asked about the weather and the road.",
    "Mira hid the silver key under the third step of the bell tower.",
    "The guard said the road to the harbour is closed.",
    "A merchant sold the guard a loaf of bread.",
  ];

  it("puts the text with the rare words first and leaves out texts with no query word", () => {
    const ranked = rankTexts("where did Mira hide the silver key", texts);
    expect(ranked[0]?.index).toBe(1);
    // "the" is in every text: it gives a little score but never the first place.
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score * 3);
    expect(rankTexts("dragon", texts)).toEqual([]);
  });

  it("reports how much of the query a text answers, so a caller can leave out weak matches", () => {
    const [best] = rankTexts("silver key", texts);
    expect(best).toMatchObject({ index: 1, coverage: 1 });
    // "the" is the only query word the first text holds, and it is common.
    expect(
      rankTexts("the silver key", texts, { minCoverage: 0.5 }).map(
        (ranked) => ranked.index,
      ),
    ).toEqual([1]);
    // "dragon" is in no text, so it does not lower the coverage of "guard".
    expect(rankTexts("guard dragon", texts)[0]?.coverage).toBe(1);
  });

  it("matches a plural or possessive form and a single Chinese character", () => {
    expect(rankTexts("merchants", texts)[0]?.index).toBe(3);
    expect(rankTexts("Mira's keys", texts)[0]?.index).toBe(1);
    expect(rankTexts("剑", ["他拔出了剑。", "她收起了弓。"])[0]?.index).toBe(0);
  });

  it("keeps the order of the list for equal scores and applies the limit", () => {
    const same = ["银钥匙", "银钥匙", "银钥匙"];
    expect(rankTexts("银钥匙", same, { limit: 2 }).map((r) => r.index)).toEqual(
      [0, 1],
    );
  });

  it("returns nothing for a query or a list with no terms", () => {
    expect(rankTexts("……", texts)).toEqual([]);
    expect(rankTexts("key", [])).toEqual([]);
  });
});

describe("searchExcerpt", () => {
  it("shows the part of a long text that holds the match", () => {
    const text = `${"filler ".repeat(200)}the silver key is here`;
    const excerpt = searchExcerpt(text, "silver key", 200);
    expect(excerpt).toContain("silver key");
    expect(excerpt.length).toBeLessThanOrEqual(202);
  });
});
