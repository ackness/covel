import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverPluginAt,
  loadPluginDefinition,
  validatePluginFiles,
} from "../src/index.js";
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
