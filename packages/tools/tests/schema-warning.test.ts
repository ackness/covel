import { expect, it } from "vitest";
import { validateFieldsAgainstSchema } from "../src/schema-validator.js";

it("reports undeclared attributes without directing the model to another plugin's tool", () => {
  const result = validateFieldsAgainstSchema(
    { hp: 5, fame: 10 },
    {
      version: 1,
      attributes: [
        { id: "hp", name: "Health", type: "number", category: "stats" },
      ],
    },
  );
  expect(result.unknownKeys).toEqual(["fame"]);
  expect(result.warningText).toContain("fame");
  expect(result.warningText).toContain("hp");
  expect(result.warningText).toContain("saved");
  expect(result.warningText).not.toContain("set-world-schema");
});
