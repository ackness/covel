/**
 * `agent.tools.datasets` compiles to `{ dataset, tools }`, a name taking every
 * tool the dataset offers. The package rules reject a reference the package
 * cannot serve, at its field, in static validation and at load alike.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runtimeAuthoringManifestSchema,
  type PluginManifest,
} from "@covel/shared";
import { compileRuntimeManifest } from "../src/compile-manifest.js";
import { parsePluginMd } from "../src/parse-plugin-md.js";
import { discoverPluginAt, loadPluginDefinition } from "../src/index.js";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";

const staged = { schedule: { stage: "narrative" as const } };

const plugin: PluginManifest = {
  id: "probe",
  kind: "plugin",
  description: "Probe",
  contributes: {
    datasets: {
      notes: { schema: "./schemas/note.json", key: "id" },
      clock: { schema: "./schemas/note.json", ops: ["set"] },
    },
  },
};

const noteSchema = {
  type: "object",
  properties: { id: { type: "string" }, text: { type: "string" } },
  required: ["id"],
};

describe("compiled dataset references", () => {
  it("compiles a name to every tool the dataset offers and keeps a selection", () => {
    const manifest = compileRuntimeManifest(
      plugin,
      {
        ...staged,
        agent: {
          tools: {
            datasets: ["notes", { dataset: "clock", tools: ["get"] }],
          },
        },
      },
      "probe/teller",
    );
    expect(manifest.tools?.datasets).toEqual([
      { dataset: "notes", tools: ["get", "list", "upsert", "update"] },
      { dataset: "clock", tools: ["get"] },
    ]);
  });

  it("takes the dataset's written tools for a name", () => {
    const manifest = compileRuntimeManifest(
      {
        ...plugin,
        contributes: {
          datasets: {
            notes: { schema: "./n.json", tools: ["list", "upsert"] },
          },
        },
      },
      { ...staged, agent: { tools: { datasets: ["notes"] } } },
      "probe/teller",
    );
    expect(manifest.tools?.datasets).toEqual([
      { dataset: "notes", tools: ["list", "upsert"] },
    ]);
  });

  it("grants no dataset tools to a runtime that lists none", () => {
    const manifest = compileRuntimeManifest(
      plugin,
      { ...staged, agent: {} },
      "probe",
    );
    expect(manifest.tools?.datasets).toBeUndefined();
  });

  it("rejects datasets in a function runtime", () => {
    const result = runtimeAuthoringManifestSchema.safeParse({
      ...staged,
      function: { tools: { datasets: ["notes"] } },
    });
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    ).toEqual([expect.stringMatching(/^function\.tools: Unrecognized key/)]);
  });

  it("rejects an empty selection", () => {
    const result = runtimeAuthoringManifestSchema.safeParse({
      ...staged,
      agent: { tools: { datasets: [{ dataset: "notes", tools: [] }] } },
    });
    expect(result.success).toBe(false);
  });

  it("carries tools and description on the compiled declaration", () => {
    const root = parsePluginMd(
      `---\n${JSON.stringify({
        id: "probe",
        kind: "plugin",
        description: "Probe",
        contributes: {
          datasets: {
            notes: {
              schema: "./n.json",
              ops: ["set", "merge"],
              description: "Notes the agent keeps.",
            },
            clock: { schema: "./c.json", ops: ["set"], tools: ["get"] },
          },
        },
      })}\n---\n`,
      "probe/PLUGIN.md",
    );
    expect(root.manifest.datasets).toEqual({
      notes: {
        namespace: "notes",
        schema: "./n.json",
        ops: ["set", "merge"],
        tools: ["get", "list", "upsert", "update"],
        description: "Notes the agent keeps.",
      },
      clock: {
        namespace: "clock",
        schema: "./c.json",
        ops: ["set"],
        tools: ["get"],
      },
    });
  });
});

describe("dataset reference rules", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function pkg(
    agent: Record<string, unknown>,
    contributes: Record<string, unknown> = {},
  ): Promise<string> {
    const temp = await mkdtemp(path.join(os.tmpdir(), "covel-dataset-tools-"));
    roots.push(temp);
    const dir = path.join(temp, "probe");
    await mkdir(path.join(dir, "runtimes", "teller"), { recursive: true });
    await mkdir(path.join(dir, "schemas"), { recursive: true });
    await writeFile(
      path.join(dir, "schemas", "note.json"),
      JSON.stringify(noteSchema),
    );
    await writeFile(
      path.join(dir, "PLUGIN.md"),
      `---\n${JSON.stringify({
        id: "probe",
        kind: "plugin",
        description: "Probe",
        ...(contributes.tools ? { entry: "./entry.js" } : {}),
        contributes: {
          datasets: {
            notes: { schema: "./schemas/note.json", key: "id", ops: ["set"] },
          },
          ...contributes,
        },
      })}\n---\n`,
    );
    await writeFile(path.join(dir, "entry.js"), "export default () => {};\n");
    await writeFile(
      path.join(dir, "runtimes", "teller", "RUNTIME.md"),
      `---\n${JSON.stringify({ ...staged, agent })}\n---\nTell.\n`,
    );
    return dir;
  }

  async function validate(dir: string): Promise<string> {
    let stderr = "";
    const status = await runValidateManifest([dir], {
      stdout: { write: () => true },
      stderr: { write: (text) => (stderr += text) },
    });
    expect(status).toBe(stderr ? 1 : 0);
    return stderr;
  }

  async function load(dir: string): Promise<unknown> {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadPluginDefinition((await discoverPluginAt(dir))!);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it("accepts a valid reference", async () => {
    const dir = await pkg({ tools: { datasets: ["notes"] } });
    expect(await validate(dir)).toBe("");
    expect(await load(dir)).toBeUndefined();
  });

  const long = `n${"o".repeat(57)}`;
  it.each([
    {
      case: "an unknown dataset",
      agent: { tools: { datasets: ["journal"] } },
      field: "agent.tools.datasets.0",
      text: "dataset journal is not declared in contributes.datasets",
    },
    {
      case: "a tool the dataset does not offer",
      agent: {
        tools: { datasets: [{ dataset: "notes", tools: ["get", "update"] }] },
      },
      field: "agent.tools.datasets.0.tools.1",
      text: "does not offer the update tool",
    },
    {
      case: "a dataset name too long for its tools",
      agent: { tools: { datasets: [long] } },
      contributes: {
        datasets: { [long]: { schema: "./schemas/note.json", key: "id" } },
      },
      field: "agent.tools.datasets.0",
      text: "is longer than 64 characters",
    },
    {
      case: "a framework tool",
      agent: { tools: { datasets: ["world-dimension"] } },
      contributes: {
        datasets: {
          "world-dimension": { schema: "./schemas/note.json", ops: ["set"] },
        },
      },
      field: "agent.tools.datasets.0",
      text: "world-dimension-get has the name of a framework tool",
    },
    {
      case: "a plugin tool the runtime declares",
      agent: { tools: { plugin: ["notes-get"], datasets: ["notes"] } },
      contributes: { tools: ["notes-get"] },
      field: "agent.tools.datasets.0",
      text: "notes-get has the name of a tool the runtime declares",
    },
    {
      case: "a tool the package contributes",
      agent: { tools: { plugin: [], datasets: ["notes"] } },
      contributes: { tools: ["notes-list"] },
      field: "agent.tools.datasets.0",
      text: "notes-list has the name of a tool in contributes.tools",
    },
    {
      case: "an imported service",
      agent: {
        tools: {
          services: [{ contract: "notes.lookup@1", as: "notes-get" }],
          datasets: ["notes"],
        },
      },
      field: "agent.tools.datasets.0",
      text: "notes-get has the name of an imported service tool",
    },
    {
      case: "a duplicate reference",
      agent: {
        tools: { datasets: ["notes", { dataset: "notes", tools: ["get"] }] },
      },
      field: "agent.tools.datasets.1",
      text: "dataset notes is listed more than once",
    },
  ])("rejects $case at $field", async ({ agent, contributes, field, text }) => {
    const dir = await pkg(agent, contributes);
    const message = await validate(dir);
    expect(message).toContain(`RUNTIME.md: ${field}: `);
    expect(message).toContain(text);
    // Loading reaches the same verdict.
    const error = await load(dir);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`${field}: `);
    expect((error as Error).message).toContain(text);
  });
});
