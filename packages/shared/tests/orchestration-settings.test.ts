import { describe, expect, it } from "vitest";
import * as sdk from "@covel/plugin-handlers-utils";
import {
  characterActorOutputSchema,
  turnPolicyInputSchema,
  turnActionSchema,
  normalizeOrchestrationSettings,
  orchestrationSettingsPatchSchema,
  delegationSnapshotSchema,
} from "../src/index.js";

describe("orchestration settings and schema authority", () => {
  it("shares the SDK authority for actions and both reserved contracts", () => {
    expect(characterActorOutputSchema).toBe(sdk.characterActorOutputSchema);
    expect(turnPolicyInputSchema).toBe(sdk.turnPolicyInputSchema);
    expect(turnActionSchema).toBe(sdk.turnActionSchema);
  });
  it("normalizes absent preferences without replacing zero", () => {
    expect(normalizeOrchestrationSettings()).toEqual({
      maxActors: 4,
      maxSubagentCalls: 16,
    });
    expect(
      normalizeOrchestrationSettings({ maxActors: 0, maxSubagentCalls: 0 }),
    ).toEqual({ maxActors: 0, maxSubagentCalls: 0 });
    expect(
      orchestrationSettingsPatchSchema.parse({ turnPolicy: null }),
    ).toEqual({ turnPolicy: null });
  });
  it.each([
    { maxActors: 17 },
    { maxSubagentCalls: -1 },
    { maxActors: 0.5 },
    { turnPolicy: "policy" },
    { extra: true },
  ])("rejects malformed preferences %j", (value) => {
    expect(orchestrationSettingsPatchSchema.safeParse(value).success).toBe(
      false,
    );
  });
  it("rejects forged or inconsistent persisted admissions", () => {
    const saved = {
      scopeId: "scope",
      limits: { maxActors: 1, maxSubagentCalls: 2 },
      calls: 1,
      actorIds: ["a"],
    };
    expect(delegationSnapshotSchema.parse(saved)).toEqual(saved);
    for (const extra of [
      { calls: -1 },
      { calls: 3 },
      { actorIds: ["a", "a"] },
      { calls: 0 },
    ])
      expect(
        delegationSnapshotSchema.safeParse({ ...saved, ...extra }).success,
      ).toBe(false);
  });
});
