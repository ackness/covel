import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";
import { discoverPluginAt } from "../src/discover.js";
import { loadPluginDefinition } from "../src/load.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeManifest(dir: string, file: string, value: unknown) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, file),
    `---\n${JSON.stringify(value)}\n---\nPrompt.\n`,
  );
}

/** A package with one root manifest and the given child runtimes. */
async function plugin(
  root: Record<string, unknown>,
  runtimes: Record<string, Record<string, unknown>> = {},
) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "covel-warnings-"));
  roots.push(temp);
  const dir = path.join(temp, "probe");
  await writeManifest(dir, "PLUGIN.md", { description: "Probe", ...root });
  await writeFile(
    path.join(dir, "handler.js"),
    "export default () => ({ outcome: 'success' });",
  );
  for (const [id, runtime] of Object.entries(runtimes))
    await writeManifest(path.join(dir, "runtimes", id), "RUNTIME.md", runtime);
  return dir;
}

async function validate(dir: string) {
  let stdout = "";
  let stderr = "";
  const status = await runValidateManifest([dir], {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  const warnings = stdout
    .split("\n")
    .filter((line) => line.startsWith("  warning: "));
  return { status, stderr, warnings };
}

const agent = {
  description: "Notes",
  schedule: { stage: "post-turn" },
};

describe("validate:plugin warnings for a field written with its default", () => {
  it("names every default a runtime restates and still passes", async () => {
    const dir = await plugin(
      { version: "1.0.0", requires: ["narrative-engine@2"] },
      {
        notes: {
          ...agent,
          schedule: {
            stage: "post-turn",
            every: 1,
            trigger: { type: "auto" },
            detached: false,
          },
          io: {
            visibility: "system",
            inputs: {
              narrative: {
                from: { contract: "narrative-engine@2", cardinality: "one" },
                required: true,
                scope: "turn",
              },
            },
            selfData: [
              {
                namespace: "notes",
                as: "<notes>",
                format: "summary",
                maxEntries: 50,
              },
            ],
          },
          agent: {
            model: "plugin",
            reasoning: true,
            loop: { timeoutMs: 120000, callTimeoutMs: 60000, maxRetries: 3 },
          },
        },
        record: {
          function: { handler: "../../handler.js" },
          schedule: { trigger: { type: "manual" }, background: false },
        },
        sweep: {
          function: { handler: "../../handler.js" },
          schedule: { stage: "audit", detached: { settle: false } },
        },
      },
    );
    const result = await validate(dir);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const fields = result.warnings.map(
      (line) =>
        line.replace(/^ {2}warning: .*?RUNTIME\.md: /, "").split(":")[0],
    );
    expect(fields.sort()).toEqual(
      [
        "agent.loop.callTimeoutMs",
        "agent.loop.maxRetries",
        "agent.loop.timeoutMs",
        "agent.model",
        "agent.reasoning",
        "io.inputs.narrative.from.cardinality",
        "io.inputs.narrative.required",
        "io.inputs.narrative.scope",
        "io.selfData[0].format",
        "io.selfData[0].maxEntries",
        "io.visibility",
        "schedule.background",
        "schedule.detached",
        "schedule.detached.settle",
        "schedule.every",
        "schedule.trigger.type",
      ].sort(),
    );
    expect(result.warnings[0]).toContain("is the default value; remove it");
  });

  it("compares a story agent with the story defaults", async () => {
    const dir = await plugin(
      { version: "1.0.0" },
      {
        narrator: {
          ...agent,
          schedule: { stage: "narrative" },
          io: {
            visibility: "story",
            output: { contract: "narrative-engine@2" },
          },
          agent: {
            model: "story",
            // A system agent's defaults are not a story agent's.
            loop: { timeoutMs: 120000, callTimeoutMs: 120000, maxRetries: 1 },
          },
        },
      },
    );
    const { status, warnings } = await validate(dir);
    expect(status).toBe(0);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("agent.model");
    expect(warnings.join("\n")).toContain("agent.loop.callTimeoutMs");
    expect(warnings.join("\n")).toContain("agent.loop.maxRetries");
    expect(warnings.join("\n")).not.toContain("agent.loop.timeoutMs");
  });

  it("compares loop behaviour keys with the profile they override", async () => {
    const dir = await plugin(
      { version: "1.0.0" },
      {
        narrator: {
          ...agent,
          schedule: { stage: "narrative" },
          io: {
            visibility: "story",
            output: { contract: "narrative-engine@2" },
          },
          agent: {
            loop: {
              profile: "story",
              stream: true,
              // Not the story preset's value: kept.
              steering: false,
              finalizer: { maxSteps: true, deadlineReserveMs: 5000 },
            },
          },
        },
        helper: {
          ...agent,
          schedule: { stage: "post-turn" },
          agent: {
            // An actor's fallback is answer-without-tools; system's is fail.
            loop: { profile: "actor", fallback: "answer-without-tools" },
          },
        },
      },
    );
    const { status, warnings } = await validate(dir);
    expect(status).toBe(0);
    const fields = warnings.map(
      (line) =>
        line.replace(/^ {2}warning: .*?RUNTIME\.md: /, "").split(":")[0],
    );
    expect(fields.sort()).toEqual(
      [
        "agent.loop.fallback",
        "agent.loop.finalizer.maxSteps",
        "agent.loop.profile",
        "agent.loop.stream",
      ].sort(),
    );
  });

  it("reads an inline runtime and the package contributions", async () => {
    const dir = await plugin({
      version: "1.0.0",
      entry: "./server.js",
      contributes: {
        hooks: [{ event: "TurnStart", enforce: "normal" }],
        data: { notes: { schema: "./notes.json", version: 1 } },
        prompt: [
          {
            id: "rules",
            content: "Rules.",
            position: "post-history",
            role: "system",
          },
        ],
      },
      runtime: { ...agent, io: { visibility: "system" } },
    });
    await writeFile(
      path.join(dir, "notes.json"),
      JSON.stringify({ type: "object" }),
    );
    await writeFile(path.join(dir, "server.js"), "export default () => {};");
    const { status, stderr, warnings } = await validate(dir);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    const text = warnings.join("\n");
    expect(text).toContain("PLUGIN.md: contributes.hooks[0].enforce");
    expect(text).toContain("PLUGIN.md: contributes.data.notes.version");
    expect(text).toContain("PLUGIN.md: contributes.prompt[0].role");
    expect(text).toContain("PLUGIN.md: runtime.io.visibility");
  });

  it("names a declaration that has a shorter form", async () => {
    const dir = await plugin(
      {
        version: "1.0.0",
        entry: "./server.js",
        contributes: {
          hooks: [{ event: "TurnStart" }],
          extensions: [
            { point: "prompt.segment@1", id: "notes", order: 0 },
            { point: "prompt.segment@1", id: "rules" },
          ],
        },
      },
      {
        notes: {
          ...agent,
          agent: {
            toolChoice: "required",
            completion: { require: "tool-use", afterTools: ["save"] },
          },
        },
        tally: {
          ...agent,
          agent: { finishWith: "save", toolChoice: "required" },
        },
      },
    );
    await writeFile(path.join(dir, "server.js"), "export default () => {};");
    const { status, stderr, warnings } = await validate(dir);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    const text = warnings.join("\n");
    expect(text).toContain(
      "PLUGIN.md: contributes.hooks[0]: write TurnStart; it means the same",
    );
    expect(text).toContain(
      "PLUGIN.md: contributes.extensions[0].order: 0 is the default value",
    );
    expect(text).toContain(
      "PLUGIN.md: contributes.extensions[1]: write prompt.segment@1/rules; it means the same",
    );
    expect(text).toContain(
      "notes/RUNTIME.md: agent.completion: write finishWith: save in place of completion and toolChoice; it means the same",
    );
    expect(text).toContain(
      'tally/RUNTIME.md: agent.toolChoice: "required" is the default value',
    );
    expect(warnings).toHaveLength(5);
  });

  it("stays quiet about a value that differs from the default", async () => {
    const dir = await plugin(
      { version: "1.0.0" },
      {
        notes: {
          ...agent,
          schedule: { stage: "post-turn", every: 3 },
          agent: { model: "utility", loop: { maxRetries: 1 } },
        },
      },
    );
    expect((await validate(dir)).warnings).toEqual([]);
  });
});

describe("validate:plugin warnings for a field the loader works out", () => {
  it("names each derived or defaulted package field and still passes", async () => {
    const dir = await plugin(
      {
        id: "probe",
        kind: "plugin",
        version: "1.0.0",
        entry: "./server/index.js",
        tags: ["mode:dialogue", "ui:right-panel", "cost:llm"],
        provides: ["notes@1", { contract: "summary@1", default: true }],
        contributes: {
          data: {
            notes: {
              schema: "./notes.json",
              accepts: ["notes.records@1"],
              authoring: {
                title: "Notes",
                source: { path: "data/notes.yaml", key: "id" },
              },
            },
            art: {
              schema: "./notes.json",
              accepts: ["notes.art@1"],
              authoring: {
                title: "Art",
                source: { path: "media/notes", key: "filename" },
              },
            },
          },
        },
      },
      {
        notes: {
          ...agent,
          io: { output: { contract: "notes@1" } },
        },
        summary: {
          function: { handler: "./handler.js" },
          schedule: { stage: "post-turn" },
          io: { output: { contract: "summary@1" } },
        },
      },
    );
    await writeFile(path.join(dir, "notes.json"), JSON.stringify({}));
    await mkdir(path.join(dir, "server"), { recursive: true });
    await writeFile(
      path.join(dir, "server/index.js"),
      "export default () => {};",
    );
    await writeFile(
      path.join(dir, "runtimes/summary/handler.js"),
      "export default () => ({ outcome: 'success' });",
    );
    const { status, stderr, warnings } = await validate(dir);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    const fields = warnings.map(
      (line) => /\.md: ([^:]+):/.exec(line)?.[1] ?? line,
    );
    expect(fields.sort()).toEqual(
      [
        "contributes.data.art.authoring.source.key",
        "contributes.data.notes.authoring.source.key",
        "entry",
        "function.handler",
        "id",
        "kind",
        "provides[0]",
        "tags[1]",
        "tags[2]",
      ].sort(),
    );
    // A provider marked as the default stays as written.
    expect(warnings.join("\n")).not.toContain("provides[1]");
  });

  it.each([
    ["the runtime type", {}, { type: "agent", ...agent }, "type"],
    ["optional contracts", { optional: ["notes@1"] }, agent, "optional"],
    [
      "a source kind",
      {
        contributes: {
          data: {
            notes: {
              schema: "./notes.json",
              accepts: ["notes.records@1"],
              authoring: {
                title: "Notes",
                source: { kind: "yaml", path: "data/notes.yaml" },
              },
            },
          },
        },
      },
      agent,
      "contributes.data.notes.authoring.source.kind",
    ],
  ] as const)(
    "reports %s as a field this host no longer reads",
    async (_name, root, runtime, field) => {
      const dir = await plugin(root, { notes: runtime });
      await writeFile(path.join(dir, "notes.json"), JSON.stringify({}));
      // Loading leaves the field out and keeps the package.
      const definition = await loadPluginDefinition(
        (await discoverPluginAt(dir))!,
      );
      expect(definition.ignoredFields.map((item) => item.field)).toEqual([
        field,
      ]);
      const { status, stderr } = await validate(dir);
      expect(status).toBe(1);
      expect(stderr).toContain(`${field}: unknown field`);
    },
  );
});

describe("validate:plugin warning for a missing version", () => {
  it("warns when a package with an entry module has no version", async () => {
    const dir = await plugin({ entry: "./server.js" });
    await writeFile(path.join(dir, "server.js"), "export default () => {};");
    const { status, warnings } = await validate(dir);
    expect(status).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("version: missing");
  });

  it("warns when a package with a setup runtime has no version", async () => {
    const dir = await plugin(
      {},
      {
        seed: {
          function: { handler: "../../handler.js" },
          schedule: { stage: "setup" },
        },
      },
    );
    expect((await validate(dir)).warnings.join("\n")).toContain(
      "version: missing",
    );
  });

  it("does not ask a prompt-only package for a version", async () => {
    const dir = await plugin({ runtime: agent });
    expect((await validate(dir)).warnings).toEqual([]);
  });

  // The runtime counts a missing version as 0.0.0 for setup records.
  it("loads a package without a version", async () => {
    const dir = await plugin({ runtime: agent });
    const definition = await loadPluginDefinition(
      (await discoverPluginAt(dir))!,
    );
    expect(definition.packageManifest.plugin.version).toBeUndefined();
  });
});
