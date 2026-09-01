import { describe, expect, it } from "vitest";
import { findLoreQualityErrors } from "./validation-helpers.js";

const VALID_LORE = `# The Glass City

The technomantic framework follows a social model in which every ritual has a cost. The oracle Api records each oath.

1. Repair the broken gate.
2. Find the missing keeper.
3. Stop the coming storm.`;

describe("findLoreQualityErrors", () => {
  it("allows ambiguous technical words when used as world lore", () => {
    expect(findLoreQualityErrors(VALID_LORE)).toEqual([]);
  });

  it("still rejects explicit meta generation wording", () => {
    const lore = VALID_LORE.replace(
      "The technomantic framework",
      "This testing prompt",
    );

    expect(findLoreQualityErrors(lore)).toContain(
      "WORLD.md contains meta/test wording",
    );
  });
});
