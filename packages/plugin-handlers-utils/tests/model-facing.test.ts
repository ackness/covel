import { describe, expect, it } from "vitest";
import { modelFacingJson, modelHiddenPaths } from "../src/model-facing.js";

describe("modelFacingJson", () => {
  it("leaves out the session ID, UUID-valued IDs and times, at every depth", () => {
    const record = {
      id: "0f1efa4d-b478-4a0c-8665-c040097771b4",
      sessionId: "lantern-barrow-replay",
      turnId: "250873f9-1cb1-4afa-981b-f7b77ba4a920",
      formId: "tabletop-rules-allocation",
      values: { might: 2, note: "保留" },
      createdAt: "2026-10-06T08:51:22.123Z",
      nested: [
        {
          id: "edge-knows-about-1",
          evidenceTurnIds: ["a9a3b91b-04c1-4f6e-9a57-2f1d6c0b7e11"],
          lastTurnId: "a9a3b91b-04c1-4f6e-9a57-2f1d6c0b7e11",
          updatedAt: "2026-10-06T16:51:22+08:00",
          timestamp: "2026-10-06T08:51:22Z",
          validAt: 2,
        },
      ],
    };

    expect(modelFacingJson(record)).toEqual({
      formId: "tabletop-rules-allocation",
      values: { might: 2, note: "保留" },
      nested: [{ id: "edge-knows-about-1", validAt: 2 }],
    });
    // The record itself is not changed.
    expect(record.nested[0]!.evidenceTurnIds).toHaveLength(1);
  });

  it("keeps what only looks like bookkeeping by its name or by its value", () => {
    const record = {
      id: "npc-lin-yao",
      characterId: "char-e2e",
      relatedIds: ["npc-a", "a9a3b91b-04c1-4f6e-9a57-2f1d6c0b7e11"],
      emptyIds: [],
      date: "1943-06-01T08:00:00Z",
      token: "a9a3b91b-04c1-4f6e-9a57-2f1d6c0b7e11",
      lookedAt: "the bronze door",
      timestamp: "第三天夜里",
      validAt: 2,
    };
    expect(modelFacingJson(record)).toEqual(record);
  });

  it("keeps a UUID that links one part of the value to another, everywhere it appears", () => {
    const ada = "33333333-3333-4333-8333-333333333333";
    const bo = "44444444-4444-4444-8444-444444444444";
    const turn = "250873f9-1cb1-4afa-981b-f7b77ba4a920";
    const worldIR = {
      entities: [
        { id: ada, type: "character", name: "Ada" },
        { id: bo, type: "character", name: "Bo" },
        { id: "brass-key", type: "item", name: "Brass key" },
      ],
      relations: [{ from: ada, to: bo, type: "trusts" }],
      events: [
        {
          type: "inventory_change",
          participantIds: [ada, "brass-key"],
          attributes: { holder: ada },
        },
        { type: "meeting", participantIds: [ada, bo], turnId: turn },
      ],
      statements: [{ subjectIds: [bo], text: "Bo keeps the ferry log." }],
    };

    // The turn is named nowhere else, so its UUID is still bookkeeping.
    expect(modelFacingJson(worldIR)).toEqual({
      ...worldIR,
      events: [
        worldIR.events[0],
        { type: "meeting", participantIds: [ada, bo] },
      ],
    });
    expect(modelHiddenPaths(worldIR)).toEqual([
      { path: "events[1].turnId", reason: "uuid" },
    ]);
  });

  it("drops a UUID id that nothing else in the value names", () => {
    const ada = "33333333-3333-4333-8333-333333333333";
    // A session ID never links: it goes whatever it holds.
    expect(
      modelFacingJson({ entities: [{ id: ada, name: "Ada" }], sessionId: ada }),
    ).toEqual({ entities: [{ name: "Ada" }] });
    // A record that repeats its own ID links nothing.
    expect(modelFacingJson({ id: ada, name: ada, title: "Ada" })).toEqual({
      name: ada,
      title: "Ada",
    });
    // A reference counts only inside the value that is projected.
    const rows = [{ id: ada }, { ownerId: ada }];
    expect(modelFacingJson(rows)).toEqual(rows);
    expect(rows.map((row) => modelFacingJson(row))).toEqual([{}, {}]);
  });

  it("returns values that are not records as they are", () => {
    expect(modelFacingJson("2026-10-06T08:51:22.123Z")).toBe(
      "2026-10-06T08:51:22.123Z",
    );
    expect(modelFacingJson(null)).toBeNull();
    expect(modelFacingJson([1, "a", null])).toEqual([1, "a", null]);
  });

  it("does not count a record repeating its UUID through containers as a reference", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const record = {
      id,
      relatedIds: [id],
      fields: { ownerId: id, nested: [{ subjectIds: [id] }] },
      title: "Ada",
    };
    expect(modelFacingJson(record)).toEqual({
      fields: { nested: [{}] },
      title: "Ada",
    });
    expect(modelHiddenPaths(record)).toEqual([
      { path: "id", reason: "uuid" },
      { path: "relatedIds", reason: "uuid" },
      { path: "fields.ownerId", reason: "uuid" },
      { path: "fields.nested[0].subjectIds", reason: "uuid" },
    ]);
  });

  it.each(["edge-one", "44444444-4444-4444-8444-444444444444"])(
    "counts a child record with its own id (%s) pointing to its parent",
    (childId) => {
      const id = "33333333-3333-4333-8333-333333333333";
      const record = {
        id,
        name: "Ada",
        children: [{ id: childId, fields: { holder: id } }],
      };
      expect(modelFacingJson(record)).toEqual({
        id,
        name: "Ada",
        children: [
          {
            ...(childId === "edge-one" ? { id: childId } : {}),
            fields: { holder: id },
          },
        ],
      });
      expect(modelHiddenPaths(record)).toEqual(
        childId === "edge-one"
          ? []
          : [{ path: "children[0].id", reason: "uuid" }],
      );
    },
  );
});

describe("modelHiddenPaths", () => {
  it("names exactly the properties that modelFacingJson leaves out, with the reason", () => {
    const record = {
      id: "npc-lin-yao",
      date: "1943-06-01T08:00:00Z",
      lookedAt: "the bronze door",
      fields: {
        diedAt: "1943-06-01T08:00:00Z",
        mentorId: "0b9f6c0e-3d1a-4a7e-9c55-1f2e3d4c5b6a",
      },
      log: [{ note: "kept" }, { timestamp: "2026-10-06T08:51:22Z" }],
      allies: [{ id: "6d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name: "Mara" }],
      sessionId: "any",
    };
    expect(modelHiddenPaths(record)).toEqual([
      { path: "fields.diedAt", reason: "time" },
      { path: "fields.mentorId", reason: "uuid" },
      { path: "log[1].timestamp", reason: "time" },
      { path: "allies[0].id", reason: "uuid" },
    ]);
    expect(modelFacingJson(record)).toEqual({
      id: "npc-lin-yao",
      date: "1943-06-01T08:00:00Z",
      lookedAt: "the bronze door",
      fields: {},
      log: [{ note: "kept" }, {}],
      allies: [{ name: "Mara" }],
    });
  });
});
