import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_OP_KINDS } from "@covel/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverPluginAt,
  loadPluginDefinition,
  validatePluginFiles,
} from "../src/index.js";
import {
  pluginRuntimeManifests,
  resolvePluginRuntimeManifest,
} from "../src/declarations.js";
import { parsePluginMd, parseRuntimeMd } from "../src/parse-plugin-md.js";
import type { PluginRegistryEntry } from "../src/types.js";
import { readFileSync } from "node:fs";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const journalSchema = {
  type: "object",
  properties: { id: { type: "string" }, text: { type: "string" } },
  required: ["id"],
};

async function plugin(
  contributes: Record<string, unknown>,
  files: Record<string, unknown> = {
    "schemas/journal.json": journalSchema,
  },
  runtimes: string[] = [],
) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "covel-datasets-"));
  roots.push(temp);
  const dir = path.join(temp, "probe");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "PLUGIN.md"),
    `---\n${JSON.stringify({ id: "probe", kind: "plugin", description: "Probe", contributes })}\n---\n`,
  );
  for (const id of runtimes) {
    await mkdir(path.join(dir, "runtimes", id), { recursive: true });
    await writeFile(
      path.join(dir, "runtimes", id, "RUNTIME.md"),
      `---\n${JSON.stringify({ schedule: { stage: "narrative" } })}\n---\nPrompt.\n`,
    );
  }
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
async function validate(dir: string) {
  const sourcePath = path.join(dir, "PLUGIN.md");
  const root = parsePluginMd(readFileSync(sourcePath, "utf8"), sourcePath);
  validatePluginFiles(root, [], (file) => readFileSync(file, "utf8"));
}

describe("contributes.datasets compile", () => {
  it("resolves defaults: every op, a namespace, no derived key", () => {
    const root = parsePluginMd(
      `---\n${JSON.stringify({
        id: "probe",
        kind: "plugin",
        description: "Probe",
        contributes: { datasets: { journal: { schema: "./j.json" } } },
      })}\n---\n`,
      "probe/PLUGIN.md",
    );
    expect(root.manifest.datasets).toEqual({
      journal: {
        namespace: "journal",
        schema: "./j.json",
        ops: [...DATA_OP_KINDS],
      },
    });
  });

  it("keeps declared key and ops", () => {
    const root = parsePluginMd(
      `---\n${JSON.stringify({
        id: "probe",
        kind: "plugin",
        description: "Probe",
        contributes: {
          datasets: {
            journal: { schema: "./j.json", key: "id", ops: ["upsertItem"] },
          },
        },
      })}\n---\n`,
      "probe/PLUGIN.md",
    );
    expect(root.manifest.datasets?.journal).toEqual({
      namespace: "journal",
      schema: "./j.json",
      key: "id",
      ops: ["upsertItem"],
    });
  });

  it("copies datasets onto every runtime of a multi-runtime package", () => {
    const root = parsePluginMd(
      `---\n${JSON.stringify({
        id: "probe",
        kind: "plugin",
        description: "Probe",
        contributes: { datasets: { journal: { schema: "./j.json" } } },
      })}\n---\n`,
      "probe/PLUGIN.md",
    );
    const runtime = (id: string) =>
      parseRuntimeMd(
        `---\n${JSON.stringify({ schedule: { stage: "narrative" } })}\n---\n`,
        `probe/runtimes/${id}/RUNTIME.md`,
        root.plugin,
      );
    const entry: PluginRegistryEntry = {
      id: "probe",
      summary: {
        id: "probe",
        name: "Probe",
        description: "Probe",
        kind: "plugin",
        runtimeCount: 2,
      },
      status: "registered",
      loadedRuntimes: new Map(),
      packageManifest: root,
      manifests: [runtime("a"), runtime("b")],
    };
    const effective = pluginRuntimeManifests(entry).map((parsed) =>
      resolvePluginRuntimeManifest(entry, parsed.manifest),
    );
    expect(effective).toHaveLength(2);
    for (const manifest of effective)
      expect(manifest.datasets).toEqual(root.manifest.datasets);
  });

  it("leaves datasets off a runtime of a package without any", () => {
    const root = parsePluginMd(
      `---\n${JSON.stringify({ id: "probe", kind: "plugin", description: "Probe" })}\n---\n`,
      "probe/PLUGIN.md",
    );
    const parsed = parseRuntimeMd(
      `---\n${JSON.stringify({ schedule: { stage: "narrative" } })}\n---\n`,
      "probe/runtimes/a/RUNTIME.md",
      root.plugin,
    );
    const entry = { packageManifest: root, manifests: [parsed] };
    expect(
      Object.keys(resolvePluginRuntimeManifest(entry, parsed.manifest)),
    ).not.toContain("datasets");
  });
});

describe("contributes.datasets load", () => {
  const declared = {
    datasets: { journal: { schema: "./schemas/journal.json" } },
  };

  it("loads each dataset schema file", async () => {
    const notesSchema = {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    };
    const dir = await plugin(
      {
        datasets: {
          journal: { schema: "./schemas/journal.json" },
          notes: { schema: "./schemas/notes.json" },
        },
      },
      {
        "schemas/journal.json": journalSchema,
        "schemas/notes.json": notesSchema,
      },
      ["a", "b"],
    );
    const definition = await load(dir);
    expect(definition.packageManifest.datasetSchemas).toEqual({
      journal: journalSchema,
      notes: notesSchema,
    });
    expect(definition.manifests).toHaveLength(2);
    for (const { manifest } of definition.manifests)
      expect(
        resolvePluginRuntimeManifest(
          { packageManifest: definition.packageManifest, manifests: [] },
          manifest,
        ).datasets,
      ).toEqual(definition.packageManifest.manifest.datasets);
  });

  it.each(["constructor", "toString", "hasOwnProperty"])(
    "accepts a dataset named %s beside an empty or unrelated data map",
    async (name) => {
      const files = { "schemas/journal.json": journalSchema };
      const datasets = { [name]: { schema: "./schemas/journal.json" } };
      for (const data of [
        {},
        { other: { schema: "./schemas/other.json" } },
      ] as const) {
        const dir = await plugin(
          { datasets, data },
          {
            ...files,
            "schemas/other.json": journalSchema,
          },
        );
        const definition = await load(dir);
        expect(Object.keys(definition.packageManifest.datasetSchemas!)).toEqual(
          [name],
        );
        await expect(validate(dir)).resolves.toBeUndefined();
      }
    },
  );

  it("names a missing schema file", async () => {
    const dir = await plugin(declared, {});
    await expect(load(dir)).rejects.toThrow(
      /schemas\/journal\.json: contributes\.datasets\.journal\.schema: .*; provide valid JSON at the declared path/,
    );
  });

  it("names invalid JSON", async () => {
    const dir = await plugin(declared, { "schemas/journal.json": "{nope" });
    await expect(load(dir)).rejects.toThrow(
      /contributes\.datasets\.journal\.schema: .*; provide valid JSON at the declared path/,
    );
  });

  it("rejects a schema path through a symlink outside the package", async () => {
    const dir = await plugin(declared, {});
    const outside = path.join(path.dirname(dir), "outside.json");
    await writeFile(outside, JSON.stringify(journalSchema));
    await mkdir(path.join(dir, "schemas"), { recursive: true });
    await symlink(outside, path.join(dir, "schemas/journal.json"));
    await expect(load(dir)).rejects.toThrow(
      /Dataset schema path traversal rejected/,
    );
  });

  it("rejects a `..` schema path at the manifest", async () => {
    const dir = await plugin({
      datasets: { journal: { schema: "../outside.json" } },
    });
    await expect(load(dir)).rejects.toThrow(
      /schema must be a plugin-relative \.json path/,
    );
  });
});

describe("contributes.datasets key check", () => {
  const withKey = (key: string) => ({
    datasets: { journal: { schema: "./schemas/journal.json", key } },
  });

  it("accepts a required property", async () => {
    const dir = await plugin(withKey("id"));
    await expect(load(dir)).resolves.toBeDefined();
    await expect(validate(dir)).resolves.toBeUndefined();
  });

  it("rejects a property that is not required, and a missing property", async () => {
    const optional = await plugin(withKey("text"));
    const absent = await plugin(withKey("ghost"));
    for (const dir of [optional, absent]) {
      const key = dir === optional ? "text" : "ghost";
      const message = new RegExp(
        `contributes\\.datasets\\.journal\\.key: ${key} is not a required property of \\./schemas/journal\\.json; add it to the schema's properties and required, or remove key`,
      );
      await expect(load(dir)).rejects.toThrow(message);
      await expect(validate(dir)).rejects.toThrow(message);
    }
  });

  it("skips the check when the schema has no top-level properties", async () => {
    const dir = await plugin(withKey("anything"), {
      "schemas/journal.json": { allOf: [{ $ref: "#/$defs/x" }] },
    });
    await expect(load(dir)).resolves.toBeDefined();
    await expect(validate(dir)).resolves.toBeUndefined();
  });
});

describe("contributes.data and contributes.datasets", () => {
  const both = (dataSchema: string) => ({
    data: { journal: { schema: dataSchema } },
    datasets: { journal: { schema: "./schemas/journal.json" } },
  });
  const files = {
    "schemas/journal.json": journalSchema,
    "schemas/other.json": journalSchema,
  };

  it("accepts the same schema file", async () => {
    const dir = await plugin(both("schemas/journal.json"), files);
    await expect(load(dir)).resolves.toBeDefined();
    await expect(validate(dir)).resolves.toBeUndefined();
  });

  it("rejects different schema files", async () => {
    const dir = await plugin(both("./schemas/other.json"), files);
    const message =
      /data namespace journal and dataset journal must use the same schema/;
    await expect(load(dir)).rejects.toThrow(message);
    await expect(validate(dir)).rejects.toThrow(message);
  });
});
