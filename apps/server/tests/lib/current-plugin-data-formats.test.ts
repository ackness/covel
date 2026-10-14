import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

it("validates flat world rule records and rejects the unused wrapped shape", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL(
        "../../../../plugins/living-world-rules/schemas/rules.schema.json",
        import.meta.url,
      ),
      "utf-8",
    ),
  );
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const rule = {
    schemaVersion: 1,
    id: "rule-one",
    content: "The gates close at dusk.",
  };
  expect(validate(rule)).toBe(true);
  expect(
    validate({ rule, lorebookEntryId: "rule-one", updatedAt: "2026-01-01" }),
  ).toBe(false);
});
