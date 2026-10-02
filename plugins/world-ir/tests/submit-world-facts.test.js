import { describe, expect, it } from "vitest";
import makeSubmitWorldFacts from "../tools/submit-world-facts.js";

const VALID_FACTS = {
  schemaVersion: 1,
  summary: "The player found a brass key.",
  entities: [
    { id: "brass-key", type: "item", name: "Brass Key" },
    { id: "player-ren", type: "character", name: "Ren" },
  ],
  relations: [],
  events: [
    {
      id: "found-key",
      type: "inventory_change",
      participantIds: ["player-ren", "brass-key"],
      attributes: {
        item: "brass-key",
        holder: "player-ren",
        operation: "gain",
      },
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

  it("supplies the protocol version when omitted and rejects unsupported versions", async () => {
    const { schemaVersion: _version, ...withoutVersion } = VALID_FACTS;
    const parsed = submitWorldFacts.parameters.parse(withoutVersion);
    expect(await submitWorldFacts.execute(parsed)).toEqual(VALID_FACTS);
    expect(
      submitWorldFacts.parameters.safeParse({
        ...VALID_FACTS,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      submitWorldFacts.parameters.safeParse({
        ...VALID_FACTS,
        schemaVersion: null,
      }).success,
    ).toBe(false);
  });

  it("moves details written beside a fact's fields into its attributes", async () => {
    const parsed = submitWorldFacts.parameters.parse({
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
      events: [
        {
          id: "took-job",
          type: "quest_change",
          quest: "Find the keeper",
          status: "accepted",
          attributes: { giver: "Mira" },
        },
      ],
    });

    expect(parsed.relations[0]).toEqual({
      id: "trusts",
      type: "TRUSTS",
      from: "brass-key",
      to: "brass-key",
      attributes: { strength: 1 },
    });
    expect(parsed.events[0].attributes).toEqual({
      giver: "Mira",
      quest: "Find the keeper",
      status: "accepted",
    });
  });

  it("parses a fact array sent as a JSON string", async () => {
    const parsed = submitWorldFacts.parameters.parse({
      ...VALID_FACTS,
      statements: JSON.stringify([
        { id: "rule", type: "rule", content: "The tower closes at dusk." },
      ]),
    });
    expect(parsed.statements).toEqual([
      { id: "rule", type: "rule", content: "The tower closes at dusk." },
    ]);
  });

  it("still rejects a fact with a malformed field", async () => {
    const result = submitWorldFacts.parameters.safeParse({
      ...VALID_FACTS,
      relations: [{ id: "trusts", type: "TRUSTS", from: "brass-key", to: 7 }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["relations", 0, "to"] }),
      ]),
    );
  });

  it("declares referenced session characters the model left out of entities", async () => {
    const facts = submitWorldFacts.parameters.parse({
      ...VALID_FACTS,
      events: [
        {
          id: "mira-hands-key",
          type: "interaction",
          participantIds: ["session-mira", "player-ren"],
        },
      ],
    });

    const result = await submitWorldFacts.execute(facts, {
      world: {
        characters: [{ id: "session-mira", name: "Mira", type: "npc" }],
      },
    });

    expect(result.entities).toContainEqual({
      id: "session-mira",
      type: "character",
      name: "Mira",
    });
  });

  it("rejects references to ids that are neither declared nor known characters", async () => {
    const facts = submitWorldFacts.parameters.parse({
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

    await expect(
      submitWorldFacts.execute(facts, { world: { characters: [] } }),
    ).rejects.toThrow(
      'relations.0.to: entity reference "missing-place" does not exist in entities',
    );
  });

  it("drops extraction input the model copied into its arguments", async () => {
    const parsed = submitWorldFacts.parameters.parse({
      ...VALID_FACTS,
      vocabulary: [{ type: "item", name: "Brass Key" }],
      characters: [{ id: "player-ren", name: "Ren", type: "player" }],
    });
    expect(parsed).toEqual(VALID_FACTS);
  });

  it("requires the fixed attributes of profiled events", async () => {
    const result = submitWorldFacts.parameters.safeParse({
      ...VALID_FACTS,
      events: [
        {
          id: "found-key",
          type: "inventory_change",
          attributes: { item: "brass-key", operation: "acquire" },
        },
        {
          id: "took-job",
          type: "quest_change",
          attributes: { quest: "Find the keeper", status: "started" },
        },
      ],
    });

    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path.join("."));
    expect(paths).toEqual(
      expect.arrayContaining([
        "events.0.attributes.holder",
        "events.0.attributes.operation",
        "events.1.attributes.status",
      ]),
    );
  });

  it("requires an inventory change to name an item entity of this output", async () => {
    const result = submitWorldFacts.parameters.safeParse({
      ...VALID_FACTS,
      events: [
        {
          id: "found-key",
          type: "inventory_change",
          attributes: {
            item: "player-ren",
            holder: "player-ren",
            operation: "gain",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ["events", 0, "attributes", "item"] }),
    ]);
  });

  it("leaves other event types free-form", async () => {
    const result = submitWorldFacts.parameters.safeParse({
      ...VALID_FACTS,
      events: [
        { id: "talked", type: "interaction", attributes: { mood: "tense" } },
      ],
    });
    expect(result.success).toBe(true);
  });
});
