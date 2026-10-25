import { describe, expect, it } from "vitest";
import {
  narratorLore,
  narratorOnlyLoreIssues,
  playerVisibleLore,
  withNarratorOnlyLore,
} from "../src/index.js";

const PLAIN = [
  "# Greyreed",
  "",
  "A village by the marsh.",
  "",
  "## Secrets",
  "",
  "The keeper put the lamp out herself.",
  "",
  "## People",
  "",
  "- Merrial keeps the inn.",
  "",
  "Do not name the king before the third room.",
  "",
  "## Opening",
  "",
  "Rain.",
].join("\n");

/** `PLAIN` with two parts marked, the way an author writes them. */
const MARKED = PLAIN.replace(
  "## Secrets",
  "<!-- narrator-only -->\n\n## Secrets",
)
  .replace("## People", "<!-- /narrator-only -->\n\n## People")
  .replace("Do not name", "<!--Narrator_Only-->\n\nDo not name")
  .replace("## Opening", "  <!-- / narrator only -->  \n\n## Opening");

describe("narrator-only lore", () => {
  it("leaves every marked block out of what the player reads", () => {
    expect(playerVisibleLore(MARKED)).toBe(
      [
        "# Greyreed",
        "",
        "A village by the marsh.",
        "",
        "## People",
        "",
        "- Merrial keeps the inn.",
        "",
        "## Opening",
        "",
        "Rain.",
      ].join("\n"),
    );
  });

  it("gives the model the text as it was before the markers were added", () => {
    expect(narratorLore(MARKED)).toBe(PLAIN);
    expect(narratorOnlyLoreIssues(MARKED)).toEqual([]);
  });

  it("leaves lore without markers as it is", () => {
    expect(playerVisibleLore(PLAIN)).toBe(PLAIN);
    expect(narratorLore(PLAIN)).toBe(PLAIN);
    // A marker is a line of its own; a mention inside a sentence is text.
    const inline = "Write <!-- narrator-only --> on a line of its own.";
    expect(playerVisibleLore(inline)).toBe(inline);
  });

  it("hides to the end of the text when a block is not closed", () => {
    const lore = "Shown.\n\n<!-- narrator-only -->\n\nSecret.\n\n## Later\n";
    expect(playerVisibleLore(lore)).toBe("Shown.\n");
    expect(narratorLore(lore)).toContain("Secret.");
    expect(narratorOnlyLoreIssues(lore)).toEqual([
      { line: 3, kind: "unclosed" },
    ]);
  });

  it("hides after a marker it cannot read, and keeps a block open", () => {
    // A wrong closing line does not close: the rest stays hidden.
    const wrongClose =
      "Shown.\n<!-- narrator-only -->\nSecret.\n<!-- end narrator-only -->\nAlso secret.";
    expect(playerVisibleLore(wrongClose)).toBe("Shown.");
    expect(narratorOnlyLoreIssues(wrongClose)).toEqual([
      { line: 4, kind: "unrecognized" },
      { line: 2, kind: "unclosed" },
    ]);
    // A wrong opening line opens a block.
    const wrongOpen =
      "Shown.\n<!-- narrator-only: plot -->\nSecret.\n<!-- /narrator-only -->\nShown too.";
    expect(playerVisibleLore(wrongOpen)).toBe("Shown.\nShown too.");
    expect(narratorOnlyLoreIssues(wrongOpen)).toEqual([
      { line: 2, kind: "unrecognized" },
    ]);
  });

  it("reports a closing line without a block and a block inside a block", () => {
    const lore = [
      "<!-- /narrator-only -->",
      "<!-- narrator-only -->",
      "Secret.",
      "<!-- narrator-only -->",
      "Still secret.",
      "<!-- /narrator-only -->",
      "Shown.",
    ].join("\n");
    expect(playerVisibleLore(lore)).toBe("Shown.");
    expect(narratorOnlyLoreIssues(lore)).toEqual([
      { line: 1, kind: "unopened" },
      { line: 4, kind: "nested" },
    ]);
  });

  it("handles long repeated mentions without a closing comment", () => {
    const malformed = `<!--${"narratoronly".repeat(100_000)}`;
    const lore = `${malformed}\nShown.`;
    expect(playerVisibleLore(lore)).toBe(lore);
    expect(narratorLore(lore)).toBe(lore);
    expect(narratorOnlyLoreIssues(lore)).toEqual([]);
    expect(withNarratorOnlyLore("Edited.", lore)).toBe("Edited.");

    const closed = `${malformed}-->\nSecret.\n<!-- /narrator-only -->\nShown.`;
    expect(playerVisibleLore(closed)).toBe("Shown.");
    expect(narratorLore(closed)).toBe("Secret.\nShown.");
    expect(narratorOnlyLoreIssues(closed)).toEqual([
      { line: 1, kind: "unrecognized" },
    ]);
  });

  it.each(["\r", "\u2028", "\u2029"])(
    "preserves comment matching around the line separator %j",
    (separator) => {
      // Whitespace inside the marker is accepted, but arbitrary text around
      // it cannot span a line separator (the original comment used dot).
      const marker = `<!-- narratoronly narrator${separator}only -->`;
      expect(playerVisibleLore(`${marker}\nSecret.`)).toBe("");
      expect(narratorOnlyLoreIssues(`${marker}\nSecret.`)).toEqual([
        { line: 1, kind: "unrecognized" },
        { line: 1, kind: "unclosed" },
      ]);
      for (const line of [
        `<!-- before${separator}narrator-only -->`,
        `<!-- narrator-only${separator}after -->`,
      ]) {
        expect(playerVisibleLore(`${line}\nShown.`)).toBe(`${line}\nShown.`);
        expect(narratorOnlyLoreIssues(line)).toEqual([]);
      }
    },
  );

  it("treats a marker line inside a code fence as a marker", () => {
    const lore = "```\n<!-- narrator-only -->\nSecret.\n```\nAlso hidden.";
    expect(playerVisibleLore(lore)).toBe("```");
  });

  it("puts the narrator-only blocks back under lore a player edited", () => {
    const edited = `${playerVisibleLore(MARKED)}\n\nThe player is a smith.\n`;
    const whole = withNarratorOnlyLore(edited, MARKED);
    expect(playerVisibleLore(whole)).toBe(edited);
    expect(narratorLore(whole)).toContain(
      "The keeper put the lamp out herself.",
    );
    expect(narratorLore(whole)).toContain("Do not name the king");
    expect(narratorOnlyLoreIssues(whole)).toEqual([]);
    expect(withNarratorOnlyLore(edited, PLAIN)).toBe(edited);
  });
});
