import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverPluginAt,
  loadPluginDefinition,
  validatePluginFiles,
  validatePluginPackage,
} from "../src/index.js";
import { authoringWarnings } from "../src/authoring-warnings.js";
import { parsePluginMd } from "../src/parse-plugin-md.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const whisperSchema = {
  type: "object",
  properties: { target: { type: "string" } },
  required: ["target"],
  additionalProperties: false,
};

async function plugin(
  id: string,
  actionKinds: unknown,
  files: Record<string, unknown> = {
    "schemas/whisper.json": whisperSchema,
  },
) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "covel-action-kinds-"));
  roots.push(temp);
  const dir = path.join(temp, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "PLUGIN.md"),
    `---\n${JSON.stringify({ id, kind: "plugin", description: "Probe", contributes: { actionKinds } })}\n---\n`,
  );
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(
      path.join(dir, name),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return dir;
}

async function load(dir: string) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return loadPluginDefinition((await discoverPluginAt(dir))!);
}

/** The authoring-validation path: parse, then check files statically. */
function validate(dir: string) {
  const sourcePath = path.join(dir, "PLUGIN.md");
  const root = parsePluginMd(readFileSync(sourcePath, "utf8"), sourcePath);
  validatePluginFiles(root, [], (file) => readFileSync(file, "utf8"));
}

const whisper = {
  name: "whisper",
  schema: "./schemas/whisper.json",
  display: { label: { en: "Whisper", zh: "耳语" }, icon: "ear" },
};

describe("contributes.actionKinds", () => {
  async function translatedComposer() {
    return plugin(
      "conversation",
      [
        {
          name: "choose-actors",
          roles: ["player", "host"],
          actor: false,
          schema: "./schemas/choose-actors.json",
          display: {
            label: "Choose actors",
            placeholder: "Give the selected characters a direction.",
          },
        },
      ],
      {
        "schemas/choose-actors.json": {
          type: "object",
          properties: { actors: { type: "string", minLength: 1 } },
          required: ["actors"],
          additionalProperties: false,
        },
        "locales/zh.yaml": `PLUGIN.md:
  contributes:
    actionKinds:
      - name: choose-actors
        display:
          label: 选择演员
          placeholder: 给所选角色一段指示。
`,
      },
    );
  }

  it("accepts translated action placeholders through static package validation", async () => {
    const dir = await translatedComposer();
    const report = await validatePluginPackage(dir);
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual(
      [],
    );
    expect(report.ok).toBe(true);
  });

  it("loads translated labels and placeholders into the public action catalog", async () => {
    const definition = await load(await translatedComposer());
    const action = definition.packageManifest.actionKinds?.[0];
    expect(action).toMatchObject({
      kind: "conversation/choose-actors",
      roles: ["player", "host"],
      actor: false,
      fieldsSchema: {
        properties: { actors: { type: "string", minLength: 1 } },
      },
    });
    // The translated label proves the locale overlay reached the right action.
    expect(action?.display.label).toEqual({
      en: "Choose actors",
      zh: "选择演员",
    });
    expect(action?.display.placeholder).toEqual({
      en: "Give the selected characters a direction.",
      zh: "给所选角色一段指示。",
    });
  });

  it("compiles each kind with its wire ID, defaults and parsed schema", async () => {
    const dir = await plugin("whisper-pack", [
      whisper,
      {
        name: "toast",
        roles: ["host", "player"],
        text: "none",
        actor: false,
        display: { label: "Toast" },
      },
    ]);
    const definition = await load(dir);
    expect(definition.packageManifest.actionKinds).toEqual([
      {
        kind: "whisper-pack/whisper",
        source: "plugin",
        pluginId: "whisper-pack",
        roles: ["player"],
        text: "optional",
        actor: true,
        display: { label: { en: "Whisper", zh: "耳语" }, icon: "ear" },
        fieldsSchema: whisperSchema,
      },
      {
        kind: "whisper-pack/toast",
        source: "plugin",
        pluginId: "whisper-pack",
        roles: ["host", "player"],
        text: "none",
        actor: false,
        display: { label: "Toast" },
      },
    ]);
    expect(() => validate(dir)).not.toThrow();
  });

  it("lets two packages declare the same name under different wire kinds", async () => {
    const first = await load(await plugin("first-pack", [whisper]));
    const second = await load(await plugin("second-pack", [whisper]));
    expect(first.packageManifest.actionKinds?.[0]?.kind).toBe(
      "first-pack/whisper",
    );
    expect(second.packageManifest.actionKinds?.[0]?.kind).toBe(
      "second-pack/whisper",
    );
  });

  it("compiles to no kinds when the package declares none", async () => {
    const definition = await load(await plugin("plain-pack", undefined, {}));
    expect(definition.packageManifest.actionKinds).toEqual([]);
  });

  it.each([
    [
      "a base kind's name",
      [{ name: "say", display: { label: "Say" } }],
      /"say" is a base action kind/,
    ],
    [
      "a duplicate name",
      [whisper, { ...whisper }],
      /action kind "whisper" is declared more than once/,
    ],
    [
      "a missing schema file",
      [{ ...whisper, schema: "./schemas/missing.json" }],
      /missing\.json/,
    ],
    [
      "a schema path that leaves the package",
      [{ ...whisper, schema: "../outside.json" }],
      /traversal|leaves the plugin root/,
    ],
    [
      "a schema that is not a JSON object",
      [{ ...whisper, schema: "./schemas/list.json" }],
      /must hold a JSON Schema object/,
    ],
  ])("rejects %s at load and in static validation", async (_, kinds, error) => {
    const dir = await plugin("bad-pack", kinds, {
      "schemas/whisper.json": whisperSchema,
      "schemas/list.json": [1, 2],
    });
    await expect(load(dir)).rejects.toThrow(error);
    expect(() => validate(dir)).toThrow(error);
  });

  it("rejects an invalid declaration in the manifest schema", async () => {
    const dir = await plugin("bad-pack", [
      { name: "Whisper", display: { label: "Whisper" } },
    ]);
    await expect(load(dir)).rejects.toThrow(/kebab-case/);
  });
});

describe("composer fields warning", () => {
  async function composerWarnings(schema: unknown) {
    const dir = await plugin("warn-pack", [whisper], {
      "schemas/whisper.json": schema,
    });
    const definition = await load(dir);
    // The kind still loads and validates; only the composer leaves it out.
    expect(() => validate(dir)).not.toThrow();
    return authoringWarnings(
      definition.packageManifest,
      definition.manifests,
    ).filter((message) => message.includes("composer"));
  }

  it("is silent for a flat object the composer can draw", async () => {
    expect(await composerWarnings(whisperSchema)).toEqual([]);
  });

  it.each([
    [
      "a nested object",
      { type: "object", properties: { a: { type: "object" } } },
    ],
    [
      "an array property",
      { type: "object", properties: { a: { type: "array" } } },
    ],
    ["a oneOf", { type: "object", oneOf: [{ properties: {} }] }],
    ["a root that is not an object", { type: "string" }],
  ])("names the kind when the schema has %s", async (_, schema) => {
    const [warning, ...rest] = await composerWarnings(schema);
    expect(rest).toEqual([]);
    expect(warning).toContain("contributes.actionKinds[0].schema");
    expect(warning).toContain(
      "fields schema of whisper cannot be shown in the composer",
    );
  });
});
