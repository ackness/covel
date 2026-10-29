import { expect, it } from "vitest";
import { parse } from "yaml";
import { ST_IMPORT_CODES } from "@covel/shared";
import { convertStImport } from "../../src/world-import/st/convert.js";
import {
  convert,
  v1Card,
  v2Card,
  v3Card,
} from "../helpers/st-card-fixtures.js";
function file(
  result: Awaited<ReturnType<typeof convert>>,
  name: string,
): string {
  return (
    result.entries
      .find((entry) => entry.relativePath === name)
      ?.content.toString() ?? ""
  );
}
it("maps V2 text, metadata, notes and examples into a valid world bundle", async () => {
  const result = await convert([
    v2Card({
      system_prompt: "Stay kind. {{original}}",
      post_history_instructions: "Remember the beacon.",
      alternate_greetings: ["SECRET ALTERNATE"],
      extensions: { regex_scripts: ["EVIL SCRIPT"], world: "Other" },
      group_only_greetings: ["GROUP SECRET"],
    }),
  ]);
  const manifest = parse(file(result, "world.yaml"));
  expect(manifest).toMatchObject({
    id: "mira",
    name: "Mira",
    version: "1.0.0",
    defaultLocale: "en-US",
    author: { name: "Covel contributors" },
    tags: ["island", "quiet-adventure"],
    pluginPolicy: { preset: "dialogue-mode" },
  });
  expect(manifest.license).toBeUndefined();
  expect(manifest.characterSchema).toBeUndefined();
  const characters = JSON.parse(file(result, "characters/characters.json"));
  expect(characters[0]).toMatchObject({
    id: "npc-mira",
    name: "Mira",
    type: "npc",
    description: "Mira tends the island beacon.",
    blueprint: {
      persona: { summary: "Patient and curious." },
      scenarioDefaults: { opening: "Welcome, the player." },
      dialogueExamples: [
        {
          user: "Is the beacon safe?",
          character: "As long as the blue light holds.",
        },
      ],
    },
  });
  const md = file(result, "WORLD.md");
  expect(md.indexOf("## Scenario")).toBeLessThan(md.indexOf("## Opening"));
  expect(md.indexOf("## Opening")).toBeLessThan(
    md.indexOf("## Narration notes"),
  );
  expect(md).toContain("Reminder:\nRemember the beacon.");
  expect(md).not.toContain("original sample");
  const all = result.entries
    .map((entry) => entry.content.toString())
    .join("\n");
  for (const secret of ["SECRET ALTERNATE", "EVIL SCRIPT", "GROUP SECRET"])
    expect(all).not.toContain(secret);
  expect(result.report.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "alternate-greetings-unsupported",
        count: 1,
      }),
      expect.objectContaining({
        code: "extensions-ignored",
        message: expect.stringContaining("regex_scripts"),
      }),
    ]),
  );
  for (const item of result.report.items)
    expect(ST_IMPORT_CODES).toContain(item.code);
});
it("accepts V3 extras, V1, and top-level fallback", async () => {
  const result = await convert([
    v3Card(),
    v1Card(),
    {
      spec: "chara_card_v2",
      data: { name: "Other" },
      description: "Top-level fallback",
    },
  ]);
  expect(result.report.sources.map((source) => source.kind)).toEqual([
    "card-v3",
    "card-v1",
    "card-v2",
  ]);
  expect(result.report.items.some((item) => item.code === "v1-card")).toBe(
    true,
  );
  expect(
    result.report.items
      .filter((item) => item.code === "field-ignored")
      .map((item) => item.field),
  ).toEqual(
    expect.arrayContaining([
      "assets",
      "source",
      "creator_notes_multilingual",
      "character_version",
    ]),
  );
  expect(file(result, "characters/characters.json")).toContain(
    "Top-level fallback",
  );
});
it("parses two dialogue blocks and warns for unparsed examples", async () => {
  const result = await convert([
    v2Card({
      mes_example:
        "<START>\n<USER>: One\n<BOT>: Reply\ncontinued\n<start>\n{{user}}: Two\n{{char}}: Second",
    }),
    v2Card({ mes_example: "unparsed" }),
  ]);
  const characters = JSON.parse(file(result, "characters/characters.json"));
  expect(characters[0].blueprint.dialogueExamples).toEqual([
    { user: "One", character: "Reply\ncontinued" },
    { user: "Two", character: "Second" },
  ]);
  expect(result.report.items).toContainEqual(
    expect.objectContaining({ code: "mes-example-unparsed" }),
  );
});
it("truncates at a paragraph boundary and generates unique ids", async () => {
  const result = await convert(
    [
      v2Card({ description: "x".repeat(11900) + "\n\n" + "y".repeat(500) }),
      v2Card(),
      v2Card({ name: "明灯" }),
    ],
    "zh-CN",
  );
  const characters = JSON.parse(file(result, "characters/characters.json"));
  expect(characters[0].description).toHaveLength(11900);
  expect(characters.map((c: { id: string }) => c.id)).toEqual([
    "npc-mira",
    "npc-mira-2",
    expect.stringMatching(/^npc-[a-f0-9]{8}$/),
  ]);
  expect(characters[0].blueprint.scenarioDefaults.opening).toContain("玩家");
  expect(result.report.items).toContainEqual(
    expect.objectContaining({ code: "text-truncated", field: "description" }),
  );
});
it.each([
  [v2Card({ name: "<script>x</script>" }), "card-no-name"],
  [{ spec: "chara_card_v9" }, "card-spec-unsupported"],
  [v2Card({ tags: [1] }), "card-invalid"],
])("rejects invalid card", async (card, code) => {
  await expect(convert([card])).rejects.toMatchObject({ code });
});
it("caps file/card counts and detects content instead of suffix", async () => {
  await expect(
    convert(Array.from({ length: 7 }, () => v2Card())),
  ).rejects.toMatchObject({ code: "cards-limit" });
  await expect(
    convert(Array.from({ length: 9 }, () => v2Card())),
  ).rejects.toMatchObject({ code: "files-limit" });
  const result = await convertStImport({
    files: [
      {
        name: "../../not-a-card.txt",
        bytes: Buffer.from(JSON.stringify(v2Card())),
      },
    ],
    locale: "en-us",
    isIdTaken: async () => false,
  });
  expect(result.report.sources[0]?.file).toBe("not-a-card.txt");
  expect(result.report.world.locale).toBe("en-US");
});
it("reports each card even when uploaded base names match", async () => {
  const result = await convertStImport({
    files: [
      v2Card({ extensions: { one: "discard" } }),
      v2Card({ extensions: { two: "discard" } }),
    ].map((card) => ({
      name: "card.json",
      bytes: Buffer.from(JSON.stringify(card)),
    })),
    locale: "en-US",
    isIdTaken: async () => false,
  });
  const warnings = result.report.items.filter(
    (item) => item.code === "extensions-ignored",
  );
  expect(warnings).toHaveLength(2);
  expect(warnings.map((item) => item.message)).toEqual([
    "Extensions were omitted: one",
    "Extensions were omitted: two",
  ]);
});
it("caps extension and macro names, without exposing discarded values", async () => {
  const extensions = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`key${index}`, "SECRET SCRIPT"]),
  );
  extensions["<bad key>"] = "SECRET SCRIPT";
  const result = await convert([
    v2Card({
      extensions,
      scenario: "{{getvar::SECRET VARIABLE}}{{setvar::SECRET VARIABLE}}",
    }),
  ]);
  const warning = result.report.items.find(
    (item) => item.code === "extensions-ignored",
  );
  expect(warning?.count).toBe(31);
  expect(warning?.message).toContain("key19");
  expect(warning?.message).not.toContain("key20");
  expect(JSON.stringify(result.report)).not.toContain("SECRET");
  expect(result.report.items).toContainEqual(
    expect.objectContaining({ code: "macros-removed", count: 2 }),
  );
});
it("uses only the first creator-note paragraph and handles Unicode truncation", async () => {
  const result = await convert([
    v2Card({
      creator_notes: "x".repeat(279) + "😀\n\nPRIVATE",
      tags: ["x".repeat(40)],
    }),
  ]);
  expect(result.report.world.summary).toHaveLength(279);
  expect(
    result.entries.every(
      (entry) => !entry.content.toString().includes("PRIVATE"),
    ),
  ).toBe(true);
  expect(result.report.items).toContainEqual(
    expect.objectContaining({ code: "text-truncated", field: "tags" }),
  );
});
it("detects JSON after long whitespace and a BOM", async () => {
  const result = await convertStImport({
    files: [
      {
        name: "odd.txt",
        bytes: Buffer.from(
          "\uFEFF" + " ".repeat(2000) + JSON.stringify(v2Card()),
        ),
      },
    ],
    locale: "en-US",
    isIdTaken: async () => false,
  });
  expect(result.report.world.id).toBe("mira");
});
