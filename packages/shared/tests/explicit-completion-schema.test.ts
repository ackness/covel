import { describe, expect, it } from "vitest";
import {
  runtimeManifestInputSchema,
  runtimeManifestAuthoringSchema,
} from "../src/schemas/plugin.js";

const manifest = {
  name: "external-extractor",
  description: "An optional state extractor",
  stage: "post-turn",
  outputKind: "system",
  trigger: { type: "auto" },
  requireExplicitCompletion: true,
  tools: { plugin: ["save-facts"] },
  completeAfterTools: ["save-facts"],
};

describe.each([runtimeManifestInputSchema, runtimeManifestAuthoringSchema])(
  "explicit completion manifest contract",
  (schema) => {
    it("accepts a third-party extractor with a legitimate no-change path", () => {
      expect(schema.safeParse(manifest).success).toBe(true);
    });
    it.each([
      { outputKind: "story" },
      { runtimeType: "function", handler: "./handler.js" },
      { output: { schema: "./result.schema.json" } },
    ])("rejects incompatible completion channels: %j", (overrides) => {
      const result = schema.safeParse({ ...manifest, ...overrides });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(
          result.error.issues.some((issue) =>
            issue.path.includes("requireExplicitCompletion"),
          ),
        ).toBe(true);
      expect(
        schema.safeParse({
          ...manifest,
          ...overrides,
          requireExplicitCompletion: false,
        }).success,
      ).toBe(true);
    });
  },
);
