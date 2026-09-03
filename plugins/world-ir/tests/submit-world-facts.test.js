import { describe, expect, it } from "vitest";
import makeSubmitWorldFacts from "../tools/submit-world-facts.js";

const VALID_FACTS = {
  schemaVersion: 1,
  summary: "The player found a brass key.",
  entities: [{ id: "brass-key", type: "item", name: "Brass Key" }],
  relations: [],
  events: [
    {
      id: "found-key",
      type: "inventory_change",
      participantIds: ["brass-key"],
      attributes: { operation: "acquire" },
    },
  ],
  statements: [],
};

describe("submit-world-facts", () => {
  const submitWorldFacts = makeSubmitWorldFacts({
    tool: (definition) => definition,
  });

  it("returns valid World IR arguments as the tool result", async () => {
    expect(submitWorldFacts.parameters.safeParse(VALID_FACTS).success).toBe(
      true,
    );
    await expect(
      submitWorldFacts.execute(VALID_FACTS, {
        sessionId: "session-world-ir",
        turnId: "turn-world-ir",
        pluginId: "world-ir",
        runtimeId: "world-ir",
      }),
    ).resolves.toEqual(VALID_FACTS);
  });

  it("rejects extra top-level fields with a precise validation path", async () => {
    const result = submitWorldFacts.parameters.safeParse({
      ...VALID_FACTS,
      relations: [
        {
          id: "trusts",
          type: "TRUSTS",
          from: "brass-key",
          to: "brass-key",
          strength: 1,
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["relations", 0] }),
      ]),
    );
  });

  it("rejects dangling entity references before accepting the output", async () => {
    const result = submitWorldFacts.parameters.safeParse({
      ...VALID_FACTS,
      relations: [
        {
          id: "located-in",
          type: "LOCATED_IN",
          from: "brass-key",
          to: "missing-place",
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["relations", 0, "to"] }),
      ]),
    );
  });
});
