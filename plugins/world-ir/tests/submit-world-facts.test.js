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

  it("restores session ids from character handles and declares the characters", async () => {
    const facts = submitWorldFacts.parameters.parse({
      ...VALID_FACTS,
      entities: [{ id: "brass-key", type: "item", name: "Brass Key" }],
      relations: [{ id: "trusts", type: "TRUSTS", from: "mira", to: "ren" }],
      events: [
        {
          id: "mira-hands-key",
          type: "inventory_change",
          participantIds: ["mira", "ren"],
          attributes: { item: "brass-key", holder: "ren", operation: "gain" },
        },
      ],
      statements: [
        {
          id: "debt",
          type: "rule",
          content: "Ren owes Mira.",
          subjectIds: ["ren"],
        },
      ],
    });

    const result = await submitWorldFacts.execute(facts, {
      world: {
        characters: [
          { id: "session-mira", name: "Mira", type: "npc" },
          { id: "char-0b9d-ren", name: "Ren", type: "player" },
        ],
      },
    });

    expect(result.entities).toEqual([
      { id: "brass-key", type: "item", name: "Brass Key" },
      { id: "session-mira", type: "character", name: "Mira" },
      { id: "char-0b9d-ren", type: "character", name: "Ren" },
    ]);
    expect(result.relations[0]).toMatchObject({
      from: "session-mira",
      to: "char-0b9d-ren",
    });
    expect(result.events[0].participantIds).toEqual([
      "session-mira",
      "char-0b9d-ren",
    ]);
    expect(result.events[0].attributes.holder).toBe("char-0b9d-ren");
    expect(result.statements[0].subjectIds).toEqual(["char-0b9d-ren"]);
  });

  it("keeps a character the model declared under its handle", async () => {
    const facts = submitWorldFacts.parameters.parse({
      ...VALID_FACTS,
      entities: [
        {
          id: "mira",
          type: "character",
          name: "Mira",
          description: "Revealed as the keeper.",
        },
      ],
      events: [],
    });

    const result = await submitWorldFacts.execute(facts, {
      world: {
        characters: [{ id: "session-mira", name: "Mira", type: "npc" }],
      },
    });

    expect(result.entities).toEqual([
      {
        id: "session-mira",
        type: "character",
        name: "Mira",
        description: "Revealed as the keeper.",
      },
    ]);
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

  it("reads the name of an entity of the output as its id", async () => {
    const facts = submitWorldFacts.parameters.parse({
      ...VALID_FACTS,
      entities: [
        ...VALID_FACTS.entities,
        { id: "reed-voice", type: "concept", name: "Voice in the Reeds" },
        { id: "east-gate", type: "location", name: "Gate" },
        { id: "west-gate", type: "location", name: "Gate" },
      ],
      relations: [
        {
          id: "hears",
          type: "HEARS",
          from: "player-ren",
          to: "Voice in the Reeds",
        },
      ],
      statements: [
        {
          id: "voice-counts",
          type: "discovery",
          content: "The voice counts names.",
          subjectIds: ["Voice in the Reeds", "player-ren"],
        },
      ],
    });

    const result = await submitWorldFacts.execute(facts, {
      world: { characters: [] },
    });
    expect(result.relations[0].to).toBe("reed-voice");
    expect(result.statements[0].subjectIds).toEqual([
      "reed-voice",
      "player-ren",
    ]);

    // Two entities share the name: it does not say which one is meant.
    await expect(
      submitWorldFacts.execute(
        {
          ...facts,
          statements: [
            {
              id: "gate-open",
              type: "discovery",
              content: "The gate stands open.",
              subjectIds: ["Gate"],
            },
          ],
        },
        { world: { characters: [] } },
      ),
    ).rejects.toThrow('entity reference "Gate" does not exist in entities');
  });

  it("declares a referenced thing that the session vocabulary tracks", async () => {
    const vocabulary = {
      cardinality: "all",
      items: [
        { value: { entries: [{ type: "item", name: "Brass Gear" }] } },
        {
          value: {
            entries: [
              { type: "quest", name: "Find the Keeper", details: ["Go up"] },
            ],
          },
        },
      ],
    };
    const facts = submitWorldFacts.parameters.parse({
      ...VALID_FACTS,
      events: [
        {
          id: "shows-gear",
          type: "interaction",
          participantIds: ["player-ren", "Brass Gear"],
        },
      ],
      statements: [
        {
          id: "keeper-clue",
          type: "discovery",
          content: "The gear came from the keeper's door.",
          subjectIds: ["Brass Gear", "Find the Keeper"],
        },
      ],
    });

    const result = await submitWorldFacts.execute(facts, {
      world: { characters: [] },
      inputSlots: { vocabulary },
    });
    expect(result.entities.slice(VALID_FACTS.entities.length)).toEqual([
      { id: "Brass Gear", type: "item", name: "Brass Gear" },
      { id: "Find the Keeper", type: "quest", name: "Find the Keeper" },
    ]);

    // Without the vocabulary the same references are unknown.
    await expect(
      submitWorldFacts.execute(facts, { world: { characters: [] } }),
    ).rejects.toThrow('entity reference "Brass Gear" does not exist');
    // A name the vocabulary does not hold still fails.
    await expect(
      submitWorldFacts.execute(
        {
          ...facts,
          relations: [
            {
              id: "located-in",
              type: "LOCATED_IN",
              from: "Brass Gear",
              to: "Barrow Top",
            },
          ],
        },
        { world: { characters: [] }, inputSlots: { vocabulary } },
      ),
    ).rejects.toThrow('entity reference "Barrow Top" does not exist');
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

  it("lists the item of an inventory change that the model did not list", async () => {
    // The model named the torches in the event and forgot the entity.
    const parsed = submitWorldFacts.parameters.parse({
      ...VALID_FACTS,
      events: [
        ...VALID_FACTS.events,
        {
          id: "took-torches",
          type: "inventory_change",
          attributes: {
            item: "torch",
            holder: "player-ren",
            operation: "gain",
            quantity: 2,
          },
        },
      ],
    });

    expect(parsed.entities).toEqual([
      ...VALID_FACTS.entities,
      { id: "torch", type: "item", name: "torch" },
    ]);
    expect(parsed.events[1].attributes.item).toBe("torch");
  });

  it("takes an item's name in an inventory change for that item", async () => {
    const parsed = submitWorldFacts.parameters.parse({
      ...VALID_FACTS,
      events: [
        {
          id: "found-key",
          type: "inventory_change",
          attributes: {
            item: "Brass Key",
            holder: "player-ren",
            operation: "gain",
          },
        },
      ],
    });

    expect(parsed.entities).toEqual(VALID_FACTS.entities);
    expect(parsed.events[0].attributes.item).toBe("brass-key");
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
