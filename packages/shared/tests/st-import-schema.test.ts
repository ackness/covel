import { expect, it } from "vitest";
import {
  ST_IMPORT_CODES,
  stImportPreviewSchema,
  stImportResultSchema,
} from "../src/schemas/st-import.js";
const result = {
  ok: true,
  preview: true,
  kind: "world",
  id: "mira",
  restartRequired: false,
  report: {
    sources: [{ file: "mira.json", kind: "card-v2", name: "Mira" }],
    world: { id: "mira", name: "Mira", locale: "en-US", summary: "Keeper" },
    counts: { characters: 1, loreEntries: 0, hasCover: false },
    items: [
      { code: "field-ignored", level: "info", count: 1, message: "Omitted" },
    ],
  },
};
it("accepts the result and preview", () => {
  expect(stImportResultSchema.safeParse(result).success).toBe(true);
  expect(stImportPreviewSchema.safeParse(result).success).toBe(true);
});
it("rejects extra keys at each boundary", () => {
  for (const value of [
    { ...result, extra: true },
    { ...result, report: { ...result.report, extra: true } },
    {
      ...result,
      report: {
        ...result.report,
        world: { ...result.report.world, extra: true },
      },
    },
  ])
    expect(stImportResultSchema.safeParse(value).success).toBe(false);
});
it("publishes distinct stable codes", () => {
  expect(new Set(ST_IMPORT_CODES).size).toBe(ST_IMPORT_CODES.length);
  expect(ST_IMPORT_CODES).toContain("extensions-ignored");
});
