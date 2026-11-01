import { describe, expect, it } from "vitest";
import { runtimeManifestInputSchema } from "../src/schemas/plugin.js";
import { runtimeAuthoringManifestSchema } from "../src/schemas/runtime-manifest.js";

const authored = { schedule: { stage: "post-turn" } };

describe("agent output submission authoring", () => {
  it.each([
    { finishWith: "save-facts" },
    { completion: { require: "explicit" } },
    { tools: { builtin: ["submit-output"] } },
    { tools: { plugin: ["submit-output"] } },
    { tools: { defer: ["submit-output"] } },
    { completion: { afterTools: ["submit-output"] } },
    { tools: { services: [{ contract: "facts@1", as: "submit-output" }] } },
  ])(
    "rejects removed fields and reserved or unavailable tools: %j",
    (agent) => {
      expect(
        runtimeAuthoringManifestSchema.safeParse({ ...authored, agent })
          .success,
      ).toBe(false);
    },
  );

  it("accepts required business work for either output kind", () => {
    for (const visibility of ["story", "system"]) {
      expect(
        runtimeAuthoringManifestSchema.safeParse({
          ...authored,
          io: { visibility, output: { schema: "./output.json" } },
          agent: {
            tools: { plugin: ["save-facts"] },
            completion: { afterTools: ["save-facts"] },
          },
        }).success,
      ).toBe(true);
    }
  });

  it("rejects the removed compiled flag even when false", () => {
    for (const requireExplicitCompletion of [true, false]) {
      expect(
        runtimeManifestInputSchema.safeParse({
          name: "extract",
          description: "Extract",
          requireExplicitCompletion,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects contradictory compiled business prerequisites", () => {
    expect(
      runtimeManifestInputSchema.safeParse({
        name: "extract",
        description: "Extract",
        requireToolUse: false,
        completeAfterTools: ["save-facts"],
        tools: { plugin: ["save-facts"] },
      }).success,
    ).toBe(false);
  });

  it("does not allow a function to declare the host submission tool", () => {
    expect(
      runtimeAuthoringManifestSchema.safeParse({
        ...authored,
        function: { tools: { builtin: ["submit-output"] } },
      }).success,
    ).toBe(false);
  });
});
