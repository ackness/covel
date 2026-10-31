import {
  fillNarrativeTemplate,
  ToolError,
  getToolContent,
  getModelView,
} from "@covel/plugin-handlers-utils";
import { describe, expect, it, vi } from "vitest";
import { createFormTool, tool } from "@covel/tools";
import makeCharacterForm from "../tools/create-character-form.js";
import { validatePlayerName } from "../lib/player-name.js";

const registered = makeCharacterForm({ tool }, createFormTool);
const createCharacterForm = {
  ...registered,
  execute: async (...args) => {
    const raw = await registered.execute(...args);
    return { ...getToolContent(raw), model: getModelView(raw) };
  },
};
const context = {
  sessionId: "s",
  turnId: "t",
  runtimeId: "char-creator/player-init",
  pluginId: "char-creator",
  world: {
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    characters: [],
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
  it("sets the name validator itself and ignores a validator the model passed", async () => {
    expect(createCharacterForm.jsonSchema.properties).not.toHaveProperty(
      "validation",
    );
    const result = await createCharacterForm.execute(
      { ...params, validation: { name: "characterName", data: null } },
      {
        ...context,
        world: {
          seats: [
            {
              id: "main",
              controller: "human",
              role: "player",
              characters: "auto",
            },
          ],
          ...context.world,
          characters: [
            { id: "p", name: "Wren", type: "player" },
            {
              id: "a",
              name: "Tomas Vale",
              aliases: ["Quillfeather"],
              type: "npc",
            },
          ],
        },
      },
    );
    expect(result).toMatchObject({ created: true, fieldCount: 1 });
    expect(result.interaction.validation).toEqual({
      name: "player-name",
      data: {
        salt: "s:t",
        taken: [expect.stringMatching(/^[0-9a-f]{24}$/), expect.any(String)],
      },
    });
    // The whole tool result is what the client and the stored message get.
    expect(JSON.stringify(result).toLowerCase()).not.toMatch(
      /quillfeather|tomas|vale/,
    );
    expect(
      validatePlayerName(
        { characterName: "quillfeather" },
        result.interaction.validation.data,
        { locale: "en" },
      ),
    ).toMatchObject({ field: "characterName" });
  });

  it("offers the form again without the taken name and says why", async () => {
    const result = await createCharacterForm.execute(
      {
        ...params,
        narrativeTemplate: "{{characterName}} arrives because of {{motive}}.",
        fields: [
          ...params.fields,
          { name: "motive", type: "text", label: "Motive" },
        ],
      },
      {
        ...context,
        world: {
          seats: [
            {
              id: "main",
              controller: "human",
              role: "player",
              characters: "auto",
            },
          ],
          ...context.world,
          characters: [
            { id: "a", name: "Tomas Vale", aliases: ["Tomas"], type: "npc" },
          ],
        },
        store: {
          listPlayerInputs: async () => [
            {
              formId: "char-creation",
              values: { characterName: "tomas", motive: "debt" },
            },
          ],
        },
      },
    );
    expect(result.interaction.notice).toBe(
      'The name "tomas" already belongs to a character of this world. Choose another name.',
    );
    expect(result.interaction.fields).toEqual([
      { name: "characterName", type: "text", label: "Name", required: true },
      { name: "motive", type: "text", label: "Motive", defaultValue: "debt" },
    ]);
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
          narrativeTemplate: "{{characterName}} arrives because of {{motive}}.",
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
      createFormTool.execute(invalid, context).then(getToolContent),
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
          seats: [
            {
              id: "main",
              controller: "human",
              role: "player",
              characters: "auto",
            },
          ],
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
      narrativeTemplate: "{{characterName}} arrives as an {{occupation}}.",
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
        narrativeTemplate: "{{characterName}}: {{occupation}}; {{motive}}.",
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

describe("create-character-form narrative defaults", () => {
  const openingContext = (locale) => ({
    ...context,
    locale,
    world: {
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      characterSchema: {
        attributes: ["calling", "background"].map((id) => ({
          id,
          name: id,
          type: "string",
          category: "bio",
        })),
      },
    },
  });
  const opening = (calling, background, narrativeTemplate) => ({
    ...params,
    narrativeTemplate,
    fields: [
      { ...params.fields[0], defaultValue: "张三" },
      {
        name: "calling",
        type: "text",
        label: "Calling",
        defaultValue: calling,
      },
      {
        name: "background",
        type: "textarea",
        label: "Background",
        defaultValue: background,
      },
    ],
  });

  it("rejects the reported opening with a correction and no form or writes", async () => {
    const emitForm = vi.fn(createFormTool.execute);
    const checked = makeCharacterForm(
      { tool },
      { ...createFormTool, execute: emitForm },
    );
    const pendingProposals = [];
    await expect(
      checked.execute(
        opening(
          "尚未定下的冒险者",
          "为追寻一桩旧事来到灰苇村，心底藏着不愿轻易示人的秘密",
          "你叫{{characterName}}，是{{calling}}；你因{{background}}来到这里。",
        ),
        { ...openingContext("zh-CN"), pendingProposals },
      ),
    ).rejects.toThrow(
      /calling.defaultValue is an undecided placeholder[\s\S]*Choose a concrete value[\s\S]*Filled narrative: 你叫张三[\s\S]*秘密来到这里/,
    );
    expect(emitForm).not.toHaveBeenCalled();
    expect(pendingProposals).toEqual([]);
  });

  it.each([
    ["zh-CN", "寻找旧友来到", "你因{{background}}来到这里。", "来到"],
    ["zh-CN", "来到灰苇村", "你来到{{background}}。", "来到"],
    ["en-US", "to find a friend", "You came to {{background}}.", "to"],
    ["en-US", "find a friend here", "You came to {{background}} here.", "here"],
  ])(
    "rejects adjacent repetition in %s",
    async (locale, background, template, word) => {
      await expect(
        createCharacterForm.execute(
          opening("scout", background, template),
          openingContext(locale),
        ),
      ).rejects.toThrow(`background.defaultValue repeats "${word}"`);
    },
  );

  it.each([
    ["zh-CN", "待定"],
    ["zh-CN", "尚未定下的冒险者"],
    ["en-US", "TBD"],
    ["en-US", "an undecided adventurer"],
  ])("rejects an undecided calling in %s (%s)", async (locale, calling) => {
    await expect(
      createCharacterForm.execute(
        opening(
          calling,
          "debt",
          "{{characterName}}: {{calling}}; {{background}}.",
        ),
        openingContext(locale),
      ),
    ).rejects.toThrow(/calling.defaultValue is an undecided placeholder/);
  });

  it.each([
    [
      "zh-CN",
      "巡林人",
      "追寻一桩旧事",
      "你叫{{characterName}}，是{{calling}}，因{{background}}来到灰苇村。",
      "你叫张三，是巡林人，因追寻一桩旧事来到灰苇村。",
    ],
    [
      "en-US",
      "a scout",
      "a promise to an undecided voter.",
      "{{characterName}} is {{calling}}, bound by {{background}}.",
      "张三 is a scout, bound by a promise to an undecided voter.",
    ],
  ])(
    "returns the filled opening in %s without bookkeeping",
    async (locale, calling, background, template, expected) => {
      const result = await createCharacterForm.execute(
        opening(calling, background, template),
        openingContext(locale),
      );
      expect(result.filledNarrative).toBe(expected);
      expect(result.model.data).toEqual({ filledNarrative: expected });
      expect(result.created).toBe(true);
    },
  );

  it("keeps an author's enum choice and a player's earlier answer", async () => {
    const result = await createCharacterForm.execute(
      {
        ...params,
        narrativeTemplate: "{{characterName}}: {{occupation}}; {{motive}}.",
        fields: [
          ...params.fields,
          {
            name: "occupation",
            type: "select",
            label: "Occupation",
            options: ["undecided"],
            defaultValue: "undecided",
          },
          {
            name: "motive",
            type: "text",
            label: "Motive",
            defaultValue: "exploration",
          },
        ],
      },
      {
        ...context,
        locale: "en-US",
        world: {
          seats: [
            {
              id: "main",
              controller: "human",
              role: "player",
              characters: "auto",
            },
          ],
          characterSchema: {
            attributes: [
              context.world.characterSchema.attributes[0],
              {
                ...context.world.characterSchema.attributes[2],
                options: ["undecided"],
              },
            ],
          },
        },
        store: {
          listPlayerInputs: async () => [
            {
              formId: "char-creation",
              values: { characterName: "Wren", motive: "undecided" },
            },
          ],
        },
      },
    );
    expect(result.filledNarrative).toBe("Wren: undecided; undecided.");
  });

  it("does not confuse similar words or punctuation with adjacent repetition", async () => {
    await expect(
      createCharacterForm.execute(
        opening(
          "a scout",
          "tomorrow",
          "{{characterName}} is {{calling}}. You came to {{background}}; tomorrow will be different.",
        ),
        openingContext("en-US"),
      ),
    ).resolves.toHaveProperty("created", true);
  });

  it("renders blank optional defaults as missing, as submission does", async () => {
    const result = await createCharacterForm.execute(
      opening(
        "scout",
        "   ",
        "{{characterName}}: {{calling}} / {{background}}",
      ),
      openingContext("en-US"),
    );
    expect(result.filledNarrative).toBe("张三: scout / ");
  });

  it("rejects hardcoded answers before creating an interaction, then echoes edited answers", async () => {
    const execute = vi.fn(createFormTool.execute);
    const checked = makeCharacterForm({ tool }, { ...createFormTool, execute });
    const form = {
      ...params,
      narrativeTemplate: "{{characterName}} arrives, motivated by exploration.",
      fields: [
        ...params.fields,
        {
          name: "motive",
          label: "Motive",
          type: "text",
          defaultValue: "exploration",
        },
      ],
    };
    await expect(checked.execute(form, context)).rejects.toThrow(
      /must include \{\{motive\}\}/,
    );
    expect(execute).not.toHaveBeenCalled();
    const result = getToolContent(
      await checked.execute(
        {
          ...form,
          narrativeTemplate:
            "{{ characterName }} arrives, motivated by {{ motive }}.",
        },
        context,
      ),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(
      fillNarrativeTemplate(result.interaction.narrativeTemplate, {
        characterName: "Wren",
        motive: "repaying a debt",
      }),
    ).toBe("Wren arrives, motivated by repaying a debt.");
  });

  it("reports a missing name placeholder as invalid-input before publishing a form", async () => {
    const execute = vi.fn(createFormTool.execute);
    const checked = makeCharacterForm({ tool }, { ...createFormTool, execute });
    await expect(
      checked.execute(
        { ...params, narrativeTemplate: "Wren arrives." },
        context,
      ),
    ).rejects.toMatchObject({
      code: "invalid-input",
      message: expect.stringContaining("must include {{characterName}}"),
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(checked.execute(params, context)).resolves.toBeDefined();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("preserves unexpected downstream failures", async () => {
    const failure = new Error("form publisher unavailable");
    const checked = makeCharacterForm(
      { tool },
      {
        ...createFormTool,
        execute: async () => {
          throw failure;
        },
      },
    );
    await expect(checked.execute(params, context)).rejects.toBe(failure);
  });

  it("rejects missing and long unclosed placeholders without creating a form", async () => {
    await expect(
      createCharacterForm.execute(
        { ...params, narrativeTemplate: undefined },
        context,
      ),
    ).rejects.toThrow("Tool parameter validation failed");
    await expect(
      createCharacterForm.execute(
        { ...params, narrativeTemplate: `{{${" ".repeat(10000)}` },
        context,
      ),
    ).rejects.toThrow(/must include \{\{characterName\}\}/);
  });
});

it("includes another player character's name in the form validator", async () => {
  const result = await createCharacterForm.execute(params, {
    ...context,
    world: {
      ...context.world,
      characters: [
        { id: "first", type: "player", name: "Wren" },
        { id: "second", type: "player", name: "Rowan" },
      ],
      seats: [
        {
          id: "main",
          controller: "human",
          role: "player",
          characters: "auto",
          currentCharacterId: "second",
        },
      ],
    },
  });
  expect(
    validatePlayerName(
      { characterName: "Wren" },
      result.interaction.validation.data,
      { locale: "en" },
    ),
  ).toMatchObject({ field: "characterName" });
  expect(
    validatePlayerName(
      { characterName: "Rowan" },
      result.interaction.validation.data,
      { locale: "en" },
    ),
  ).toBeUndefined();
});

it.each([
  [
    "uncollectable field",
    [{ name: "duty", type: "text", label: "Duty" }],
    "The form cannot collect: duty (not an attribute of this world). The form may hold characterName and these attributes of the world: motive (string), occupation (enum: engineer | medic). Remove every other field, and its placeholder in narrativeTemplate.",
  ],
  [
    "numeric input for a string",
    [{ name: "motive", type: "number", label: "Motive" }],
    "Field motive requires a string-valued input.",
  ],
  [
    "invented enum option",
    [
      {
        name: "occupation",
        type: "select",
        label: "Occupation",
        options: ["pilot"],
      },
    ],
    "Field occupation must use the world's exact enum options.",
  ],
  [
    "missing name",
    [{ name: "motive", type: "text", label: "Motive" }],
    "Include a required characterName text field.",
  ],
])(
  "returns invalid-input for %s with the complete correction",
  async (name, fields, message) => {
    const request = {
      ...params,
      fields: name === "missing name" ? fields : [...params.fields, ...fields],
    };
    const error = await createCharacterForm
      .execute(request, context)
      .catch((error) => error);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: "invalid-input", message });
  },
);
