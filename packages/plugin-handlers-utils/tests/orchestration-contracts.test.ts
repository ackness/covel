import { describe, expect, it } from "vitest";
import {
  characterActorInputSchema,
  characterActorOutputSchema,
  turnPolicyInputSchema,
  turnPolicyRequestSchema,
  turnPolicyOutputSchema,
  turnPolicyModelInputSchema,
  validateTurnPolicyOutput,
  turnActionSchema,
} from "../src/index.js";

const request = {
  actions: [],
  present: [{ characterId: "semantic-character", name: "Mara" }],
  recentSegments: [],
};
const input = { ...request, limits: { maxActors: 4, maxSubagentCalls: 16 } };
const plan = {
  actors: [],
  order: "parallel",
  narrator: "after",
  yieldHint: "user",
};
describe("orchestration contracts", () => {
  it("distinguishes caller requests from canonical inputs", () => {
    expect(turnPolicyRequestSchema.parse(request)).toEqual(request);
    expect(turnPolicyInputSchema.safeParse(request).success).toBe(false);
    expect(turnPolicyInputSchema.parse(input)).toEqual(input);
    expect(turnPolicyModelInputSchema.safeParse(request).success).toBe(false);
    expect(
      turnPolicyModelInputSchema.parse({
        present: ["Mara"],
        recentSegments: [],
      }),
    ).toEqual({ present: ["Mara"], recentSegments: [] });
  });
  it("accepts an empty plan but rejects unknown or repeated actors", () => {
    expect(turnPolicyOutputSchema.parse(plan)).toEqual(plan);
    expect(() =>
      validateTurnPolicyOutput(input, {
        ...plan,
        actors: [{ characterId: "elsewhere" }],
      }),
    ).toThrow();
    expect(() =>
      validateTurnPolicyOutput(input, {
        ...plan,
        actors: [
          { characterId: "semantic-character" },
          { characterId: "semantic-character" },
        ],
      }),
    ).toThrow();
  });
  it.each([
    { speaker: "Other" },
    { effects: [] },
    { kind: "narration" },
    { text: "" },
    { text: "a".repeat(4001) },
  ])("rejects invalid actor segments %j", (extra) => {
    expect(
      characterActorOutputSchema.safeParse({
        segments: [{ kind: "dialogue", text: "Hello", ...extra }],
      }).success,
    ).toBe(false);
  });
  it("bounds strict actor input and private intent", () => {
    expect(
      characterActorInputSchema.parse({
        characterId: "semantic-character",
        brief: "Speak",
      }),
    ).toBeDefined();
    expect(
      characterActorInputSchema.safeParse({
        characterId: "x",
        brief: "a".repeat(20001),
      }).success,
    ).toBe(false);
    expect(
      characterActorOutputSchema.safeParse({
        segments: [{ kind: "action", text: "Waves" }],
        intent: "a".repeat(2001),
      }).success,
    ).toBe(false);
    expect(
      characterActorOutputSchema.safeParse({ segments: [], effects: [] })
        .success,
    ).toBe(false);
    expect(
      turnPolicyRequestSchema.safeParse({ ...request, settings: {} }).success,
    ).toBe(false);
  });
  it("reuses resolved action validation including source and arbitrary plugin kinds", () => {
    const action = { seatId: "host", kind: "advance", source: "system" };
    expect(
      turnPolicyInputSchema.parse({ ...input, actions: [action] }).actions[0],
    ).toEqual(turnActionSchema.parse(action));
    expect(
      turnPolicyInputSchema.safeParse({
        ...input,
        actions: [{ ...action, source: "invented" }],
      }).success,
    ).toBe(false);
  });
});
