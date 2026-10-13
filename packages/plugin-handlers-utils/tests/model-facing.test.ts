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

  it("returns values that are not records as they are", () => {
    expect(modelFacingJson("2026-10-06T08:51:22.123Z")).toBe(
      "2026-10-06T08:51:22.123Z",
    );
    expect(modelFacingJson(null)).toBeNull();
    expect(modelFacingJson([1, "a", null])).toEqual([1, "a", null]);
  });
});

describe("modelHiddenPaths", () => {
  it("names exactly the properties that modelFacingJson leaves out, with the reason", () => {
    const uuid = "0b9f6c0e-3d1a-4a7e-9c55-1f2e3d4c5b6a";
    const record = {
      id: "npc-lin-yao",
      date: "1943-06-01T08:00:00Z",
      lookedAt: "the bronze door",
      fields: { diedAt: "1943-06-01T08:00:00Z", mentorId: uuid },
      log: [{ note: "kept" }, { timestamp: "2026-10-06T08:51:22Z" }],
      allies: [{ id: uuid, name: "Mara" }],
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
