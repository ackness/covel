import { describe, expect, it } from "vitest";
import projectWorldIR from "../server/project-world-ir.js";

describe("living-world-rules WorldIR projection", () => {
  it("projects rule statements and ignores unrelated statements", () => {
    const result = projectWorldIR({
      value: {
        schemaVersion: 1,
        summary: "A small coastal school.",
        entities: [],
        relations: [],
        events: [],
        statements: [
          {
            id: "school-day",
            type: "rule",
            content: "The school closes at 18:00.",
            attributes: {
              title: "School day",
              kind: "constant",
              category: "world",
              enabled: true,
              coordinate: { position: "before_plugin" },
              budgetClass: "sticky",
              keys: ["school", "closing"],
              insertionOrder: 415,
              ignoredByThisPlugin: "kept in the neutral IR only",
            },
          },
          {
            id: "meet-mio",
            type: "task",
            content: "Meet Mio after class.",
          },
        ],
      },
      context: {
        sessionId: "session-1",
        worldId: "demo",
        sourceId: "worldIr",
        now: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(result).toEqual({
      rules: [
        {
          schemaVersion: 1,
          id: "world-ir-38a695911e34092fef36dbab39a3431ef98ecb5686fa70813d829fbbeb7de34b",
          sourceStatementId: "school-day",
          title: "School day",
          content: "The school closes at 18:00.",
          kind: "constant",
          category: "world",
          enabled: true,
          coordinate: { position: "before_plugin" },
          budgetClass: "sticky",
          keys: ["school", "closing"],
          insertionOrder: 415,
        },
      ],
    });
  });

  it("returns an empty declared output when WorldIR has no rules", () => {
    expect(
      projectWorldIR({
        value: {
          schemaVersion: 1,
          entities: [],
          relations: [],
          events: [],
          statements: [],
        },
        context: {
          sessionId: "session-1",
          worldId: "demo",
          sourceId: "worldIr",
          now: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toEqual({ rules: [] });
  });

  it("keeps Unicode and long source ids while producing distinct valid rule ids", () => {
    const sourceIds = ["雨夜:学校", "雨夜-学校", "长".repeat(200)];
    const project = () =>
      projectWorldIR({
        value: {
          statements: sourceIds.map((id) => ({
            id,
            type: "rule",
            content: "The rule remains importable.",
          })),
        },
      }).rules;
    const rules = project();
    expect(rules.map((rule) => rule.sourceStatementId)).toEqual(sourceIds);
    expect(rules.map((rule) => rule.id)).toEqual(
      project().map((rule) => rule.id),
    );
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(sourceIds.length);
    for (const rule of rules) {
      expect(rule.id).toMatch(/^world-ir-[a-f0-9]{64}$/);
      expect(rule.id.length).toBeLessThanOrEqual(128);
    }
  });
});
