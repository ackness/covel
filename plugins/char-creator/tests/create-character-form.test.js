import { describe, expect, it } from "vitest";
import { createFormTool, tool } from "@covel/tools";
import makeCharacterForm from "../tools/create-character-form.js";

const createCharacterForm = makeCharacterForm({ tool }, createFormTool);
const context = {
  sessionId: "s",
  turnId: "t",
  runtimeId: "char-creator/player-init",
  pluginId: "char-creator",
  world: {
    characterSchema: {
      attributes: [
        { id: "motive", name: "Motive", type: "string", category: "bio" },
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
  it("does not advertise validators or emit a model-invented characterName validator", async () => {
    expect(createCharacterForm.jsonSchema.properties).not.toHaveProperty(
      "validation",
    );
    const result = await createCharacterForm.execute(
      { ...params, validation: { name: "characterName", data: null } },
      context,
    );
    expect(result).toMatchObject({ created: true, fieldCount: 1 });
    expect(result.interaction.validation).toBeUndefined();
    expect(JSON.parse(JSON.stringify(result.interaction))).not.toHaveProperty(
      "validation",
    );
  });

  it("gives the form the id the setup guard reads, whatever the model passed", async () => {
    const result = await createCharacterForm.execute(
      { ...params, formId: "hero-sheet" },
      context,
    );
    expect(result.interaction.interactionId).toBe("char-creation");
  });

  it("accepts string-valued select suggestions without weakening numeric or enum validation", async () => {
    await expect(
      createCharacterForm.execute(
        {
          ...params,
          fields: [
            ...params.fields,
            {
              name: "motive",
              type: "select",
              label: "Motive",
              options: ["Find a friend", "Explore"],
              defaultValue: "Explore",
            },
          ],
        },
        context,
      ),
    ).resolves.toMatchObject({ created: true, fieldCount: 2 });
    await expect(
      createCharacterForm.execute(
        {
          ...params,
          fields: [
            ...params.fields,
            { name: "motive", type: "number", label: "Motive" },
          ],
        },
        context,
      ),
    ).rejects.toThrow(/string-valued/);
  });
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
  it("names every refused field and what the world lets the form hold", async () => {
    const invented = {
      ...params,
      fields: [
        ...params.fields,
        { name: "duty", type: "text", label: "Duty" },
        { name: "systems", type: "text", label: "Systems" },
      ],
    };
    await expect(
      createCharacterForm.execute(invented, context),
    ).rejects.toThrow(
      /duty \(not an attribute of this world\), systems \(a number attribute.*motive \(string\), occupation \(enum: engineer \| medic\)/,
    );
    // A world with numeric attributes only: the name is the whole form.
    await expect(
      createCharacterForm.execute(invented, {
        ...context,
        world: {
          characterSchema: {
            attributes: [context.world.characterSchema.attributes[1]],
          },
        },
      }),
    ).rejects.toThrow(/the form has one field: characterName/);
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
  it("offers the form again with the refused submission's answers filled in", async () => {
    const result = await createCharacterForm.execute(
      {
        ...params,
        fields: [
          ...params.fields,
          { name: "motive", type: "text", label: "Motive" },
          {
            name: "occupation",
            type: "select",
            label: "Occupation",
            options: ["engineer", "medic"],
          },
        ],
      },
      {
        ...context,
        messages: {
          translations: {
            "This world no longer accepts some of your earlier answers. Check the form and submit it again.":
              "请检查后重新提交。",
          },
        },
        store: {
          listPlayerInputs: async () => [
            {
              formId: "char-creation",
              values: {
                characterName: "Alex",
                motive: "Debt",
                occupation: "pilot",
              },
            },
            { formId: "another-form", values: { characterName: "Other" } },
          ],
        },
      },
    );
    expect(result.interaction.notice).toBe("请检查后重新提交。");
    expect(
      result.interaction.fields.map((field) => field.defaultValue),
    ).toEqual(["Alex", "Debt", undefined]);
  });
  it("adds no notice to the first form", async () => {
    const result = await createCharacterForm.execute(params, {
      ...context,
      store: { listPlayerInputs: async () => [] },
    });
    expect(result.interaction).not.toHaveProperty("notice");
  });
});
