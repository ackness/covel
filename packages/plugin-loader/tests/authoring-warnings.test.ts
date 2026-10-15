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
  await writeManifest(dir, "PLUGIN.md", {
    id: "probe",
    kind: "plugin",
    description: "Probe",
    ...root,
  });
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
  type: "agent",
  description: "Notes",
  schedule: { stage: "post-turn" },
};

describe("validate:plugin warnings for a field written with its default", () => {
  it("names every default a runtime restates and still passes", async () => {
    const dir = await plugin(
      { version: "1.0.0", requires: ["narrative-engine@1"] },
      {
        notes: {
          ...agent,
          schedule: { stage: "post-turn", every: 1, trigger: { type: "auto" } },
          io: {
            visibility: "system",
            inputs: {
              narrative: {
                from: { contract: "narrative-engine@1", cardinality: "one" },
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
            loop: { timeoutMs: 120000, callTimeoutMs: 60000, maxRetries: 3 },
          },
        },
        record: {
          type: "function",
          function: { handler: "../../handler.js" },
          schedule: { trigger: { type: "manual" }, manual: { execution: "sync" } },
        },
      },
    );
    const result = await validate(dir);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const fields = result.warnings.map((line) =>
      line.replace(/^ {2}warning: .*?RUNTIME\.md: /, "").split(":")[0],
    );
    expect(fields.sort()).toEqual(
      [
        "agent.loop.callTimeoutMs",
        "agent.loop.maxRetries",
        "agent.loop.timeoutMs",
        "agent.model",
        "io.inputs.narrative.from.cardinality",
        "io.inputs.narrative.required",
        "io.inputs.narrative.scope",
        "io.selfData[0].format",
        "io.selfData[0].maxEntries",
        "io.visibility",
        "schedule.every",
        "schedule.manual.execution",
        "schedule.trigger.type",
      ].sort(),
    );
    expect(result.warnings[0]).toContain("is the default value; remove it");
  });

  it("compares a story agent with the story defaults", async () => {
    const dir = await plugin(
      { version: "1.0.0", provides: ["narrative-engine@1"] },
      {
        narrator: {
          ...agent,
          schedule: { stage: "narrative" },
          io: { visibility: "story", output: { contract: "narrative-engine@1" } },
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
          type: "function",
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
