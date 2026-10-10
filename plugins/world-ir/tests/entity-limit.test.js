import { describe, expect, it } from "vitest";
import makeSubmitWorldFacts from "../tools/submit-world-facts.js";

describe("submit-world-facts at the entity limit", () => {
  const submitWorldFacts = makeSubmitWorldFacts({
    tool: (definition) => definition,
  });

  it("says that the output is full when an undeclared item could not be added", () => {
    const crowd = Array.from({ length: 32 }, (_, index) => ({
      id: `guest-${index}`,
      type: "character",
      name: `Guest ${index}`,
    }));
    const result = submitWorldFacts.parameters.safeParse({
      schemaVersion: 1,
      summary: "A guest found a brass key.",
      entities: crowd,
      relations: [],
      events: [
        {
          id: "found-key",
          type: "inventory_change",
          participantIds: ["guest-0"],
          attributes: {
            item: "Brass Key",
            holder: "guest-0",
            operation: "gain",
          },
        },
      ],
      statements: [],
    });
    expect(result.success).toBe(false);
    expect(
      result.error.issues.map((issue) => issue.message).join("\n"),
    ).toContain("the output already has the most entities it may hold (32)");
  });
});
