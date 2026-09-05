import { describe, expect, it } from "vitest";
import { createFormTool, tool } from "@covel/tools";
import makeCharacterForm from "../tools/create-character-form.js";

const createCharacterForm = makeCharacterForm({ tool }, createFormTool);
const context = {
  sessionId: "s",
  turnId: "t",
  runtimeId: "char-creator/player-init",
  pluginId: "char-creator",
  inputSlots: {
    "same-turn-world-schema": {
      cardinality: "one",
      source: {
        pluginId: "world-init",
        runtimeId: "world-init/schema-gen",
        resultId: "schema-result",
      },
      value: {
        "character-attributes": {
          version: 1,
          attributes: [
            {
              id: "systems",
              name: "Systems",
              type: "number",
              category: "abilities",
              min: 0,
              max: 5,
              defaultValue: 2,
            },
            {
              id: "occupation",
              name: "Occupation",
              type: "enum",
              category: "bio",
              options: ["engineer", "medic"],
            },
          ],
        },
      },
    },
  },
};
const params = {
  formId: "char-creation",
  title: "Your character",
  submitLabel: "Continue",
  narrativeTemplate: "{{characterName}} arrives.",
  fields: [
    { name: "characterName", type: "text", label: "Name", required: true },
  ],
};

describe("create-character-form schema boundary", () => {
  it("rejects a generic-form-valid select that would replace a numeric ability", async () => {
    const invalid = {
      ...params,
      fields: [
        ...params.fields,
        {
          name: "systems",
          label: "Training",
          type: "select",
          options: ["self-taught"],
          defaultValue: "self-taught",
        },
      ],
    };
    await expect(
      createFormTool.execute(invalid, context),
    ).resolves.toMatchObject({ created: true });
    await expect(createCharacterForm.execute(invalid, context)).rejects.toThrow(
      /systems/,
    );
  });
  it("keeps exact enum values and rejects narrative synonyms", async () => {
    const valid = {
      ...params,
      fields: [
        ...params.fields,
        {
          name: "occupation",
          type: "select",
          label: "Occupation",
          options: [{ value: "engineer", label: "Ship engineer" }],
          defaultValue: "engineer",
        },
      ],
    };
    await expect(
      createCharacterForm.execute(valid, context),
    ).resolves.toMatchObject({ created: true, fieldCount: 2 });
    await expect(
      createCharacterForm.execute(
        {
          ...valid,
          fields: [
            ...params.fields,
            {
              ...valid.fields[1],
              options: ["self-taught"],
              defaultValue: "self-taught",
            },
          ],
        },
        context,
      ),
    ).rejects.toThrow(/enum options/);
  });
  it("can collect the name alone when no schema is available", async () => {
    await expect(
      createCharacterForm.execute(params, {
        ...context,
        inputSlots: undefined,
      }),
    ).resolves.toMatchObject({ created: true });
  });
});
