import { describe, expect, it } from "vitest";
import { runtimeAuthoringManifestSchema } from "../src/schemas/runtime-manifest.js";

const runtime = (binding: object) => ({
  type: "agent",
  schedule: { trigger: { type: "manual" } },
  io: { inputs: { prior: binding } },
});
const committed = {
  from: { runtime: "probe/producer" },
  scope: "committed",
  recordAs: "facts",
};
describe("runtimeAuthoringManifestSchema committed inputs", () => {
  it.each(["/value", ""])(
    "rejects committed select %j at the select field",
    (select) => {
      const result = runtimeAuthoringManifestSchema.safeParse(
        runtime({ ...committed, select }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: ["io", "inputs", "prior", "select"],
              message: expect.stringContaining("committed"),
            }),
          ]),
        );
      }
    },
  );
  it.each([
    committed,
    { from: { runtime: "probe/producer" }, select: "/value" },
    { from: { runtime: "probe/producer" }, scope: "turn", select: "" },
    {
      from: { contract: "external.output@1" },
      scope: "committed",
      recordAs: "facts",
      required: false,
      accepts: "contract:external.output@1",
    },
  ])("accepts supported input %j", (binding) => {
    expect(
      runtimeAuthoringManifestSchema.safeParse(runtime(binding)).success,
    ).toBe(true);
  });
  it.each([
    { from: { runtime: "probe/producer" }, scope: "committed" },
    {
      from: { kernel: "turn-digest@1" },
      scope: "committed",
      recordAs: "facts",
    },
  ])("preserves committed source and recordAs checks %j", (binding) => {
    expect(
      runtimeAuthoringManifestSchema.safeParse(runtime(binding)).success,
    ).toBe(false);
  });
});
