import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  timeDefinitionJsonSchema,
  timeDefinitionRecordSchema,
} from "../schema.js";
import { DEFAULT_TIME } from "../clock.js";

it("publishes JSON Schema generated from the plugin's authoring schema", async () => {
  const file = new URL(
    "../schemas/time-definition.schema.json",
    import.meta.url,
  );
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(
    timeDefinitionJsonSchema,
  );
  expect(
    timeDefinitionRecordSchema.safeParse({
      id: "world",
      definition: DEFAULT_TIME,
    }).success,
  ).toBe(true);
  expect(
    timeDefinitionRecordSchema.safeParse({
      id: "other",
      definition: DEFAULT_TIME,
    }).success,
  ).toBe(false);
});
