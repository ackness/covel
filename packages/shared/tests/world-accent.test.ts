import { expect, it } from "vitest";
import { worldAccentColorSchema, worldManifestSchema } from "../src/index.js";

it.each([
  "#202020",
  "#000000",
  "#ffffff",
  "oklch(25% 0.12 75)",
  "oklch(91% 0.12 75)",
  "oklch(25 0.12 75)",
])("F-070 rejects unsafe accent lightness: %s", (accentColor) => {
  expect(worldAccentColorSchema.safeParse(accentColor).success).toBe(false);
});
it.each([
  "#c9a24b",
  "oklch(55% 0.12 75)",
  "oklch(90% 0.12 75)",
  "oklch(0.72 0.12 75)",
])("accepts supported accent lightness: %s", (accentColor) => {
  expect(worldAccentColorSchema.safeParse(accentColor).success).toBe(true);
});
it("uses the same constraint on the authored world field", () => {
  expect(
    worldManifestSchema.shape.accentColor.safeParse("#202020").success,
  ).toBe(false);
  expect(
    worldManifestSchema.shape.accentColor.safeParse(undefined).success,
  ).toBe(true);
});
