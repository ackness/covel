import { resolveAgentOutput } from "@covel/shared/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  characterActorOutputJsonSchema,
  runtimeAuthoringManifestSchema,
  serviceContributionSchema,
  storyOutputJsonSchema,
} from "@covel/shared";
import { frameworkContractSchemas } from "@covel/shared/contracts";
import { discoverPlugins } from "../src/discover.js";
import { loadRuntime, loadPluginDefinition } from "../src/load.js";
import { validatePluginPackage } from "../src/package-validation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  roots.length = 0;
});
async function fixture(schema?: string, shadow?: boolean) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "orch-loader-")),
  );
  roots.push(root);
  const dir = path.join(root, "sample");
  await fs.mkdir(dir);
  const manifest = {
    id: "sample",
    kind: "plugin",
    description: "Sample actor",
    ...(shadow
      ? { contracts: { "character-actor@1": { schema: "weak.json" } } }
      : {}),
    runtime: {
      schedule: { subagentOnly: true },
      io: {
        output: {
          contract: "character-actor@1",
          ...(schema ? { schema } : {}),
        },
      },
    },
  };
  await fs.writeFile(
    path.join(dir, "PLUGIN.md"),
    `---\n${Object.entries(manifest)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n")}\n---\nPlay the chosen character.\n`,
  );
  await fs.writeFile(
    path.join(dir, "weak.json"),
    JSON.stringify({ type: "object" }),
  );
  const [discovery] = await discoverPlugins(root);
  if (!discovery) throw new Error("Missing fixture");
  return discovery;
}
/** A package with one inline runtime and, optionally, extra files. */
async function storyPackage(
  runtime: Record<string, unknown>,
  root: Record<string, unknown> = {},
  files: Record<string, unknown> = {},
) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "story-loader-")),
  );
  roots.push(temp);
  const dir = path.join(temp, "teller");
  await fs.mkdir(dir);
  await fs.writeFile(
    path.join(dir, "PLUGIN.md"),
    `---\n${JSON.stringify({ description: "Teller", ...root, runtime })}\n---\nTell the story.\n`,
  );
  for (const [name, value] of Object.entries(files))
    await fs.writeFile(
      path.join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const [discovery] = await discoverPlugins(temp);
  if (!discovery) throw new Error("Missing fixture");
  return discovery;
}
const storyContractSchema = frameworkContractSchemas["narrative-engine@2"]!;
describe("framework story contract", () => {
  it("lets an automatic story agent provide the story contract without naming it", async () => {
    const discovery = await storyPackage({
      schedule: { stage: "narrative" },
      io: { visibility: "story" },
    });
    const definition = await loadPluginDefinition(discovery);
    expect(definition.manifests[0]!.manifest.outputContract).toBe(
      "narrative-engine@2",
    );
    expect(definition.packageManifest.plugin.provides).toEqual([
      "narrative-engine@2",
    ]);
    const loaded = await loadRuntime(discovery, "teller");
    expect(loaded.outputContractSchema).toEqual(storyContractSchema);
    expect(resolveAgentOutput(loaded)).toMatchObject({
      schemaSource: "loaded",
      schema: storyContractSchema,
    });
  });
  it("gives a manual story agent the story schema but no contract", async () => {
    const discovery = await storyPackage({
      schedule: { trigger: { type: "manual" } },
      io: { visibility: "story" },
    });
    const definition = await loadPluginDefinition(discovery);
    expect(definition.manifests[0]!.manifest.outputContract).toBeUndefined();
    expect(definition.packageManifest.plugin.provides).toBeUndefined();
    const loaded = await loadRuntime(discovery, "teller");
    expect(resolveAgentOutput(loaded)).toMatchObject({
      schemaSource: "host-story",
      schema: storyOutputJsonSchema(),
    });
  });
  it("gives an automatic function story no output schema, so its return value is normalized", async () => {
    const discovery = await storyPackage(
      {
        schedule: { stage: "narrative" },
        io: { visibility: "story" },
        function: { handler: "./handler.js" },
      },
      {},
      {
        "handler.js":
          'export default async () => ({ outcome: "success", value: { narrativeOutput: "Rain." } });',
      },
    );
    const definition = await loadPluginDefinition(discovery);
    expect(definition.manifests[0]!.manifest.outputContract).toBe(
      "narrative-engine@2",
    );
    const loaded = await loadRuntime(discovery, "teller");
    expect(loaded.outputSchema).toBeUndefined();
    expect(loaded.outputContractSchema).toEqual(storyContractSchema);
  });
  it("still asks a function story for a schema before it records its output", async () => {
    const discovery = await storyPackage(
      {
        schedule: { stage: "narrative" },
        io: { visibility: "story", output: { recordAs: "latest" } },
        function: { handler: "./handler.js" },
      },
      {},
      { "handler.js": "" },
    );
    await expect(loadPluginDefinition(discovery)).rejects.toThrow(
      "io.output.schema is required when io.output.recordAs is declared",
    );
  });
  it("keeps the first automatic story runtime of a package by runtime ID and leaves out the others", async () => {
    const temp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "story-loader-")),
    );
    roots.push(temp);
    const dir = path.join(temp, "teller");
    await fs.mkdir(dir);
    await fs.writeFile(
      path.join(dir, "PLUGIN.md"),
      "---\ndescription: Two tellers\n---\n",
    );
    for (const id of ["zeta", "alpha", "aside"]) {
      await fs.mkdir(path.join(dir, "runtimes", id), { recursive: true });
      await fs.writeFile(
        path.join(dir, "runtimes", id, "RUNTIME.md"),
        `---\n${JSON.stringify({
          description: `Teller ${id}`,
          schedule:
            id === "aside"
              ? { trigger: { type: "manual" } }
              : { stage: "narrative" },
          io: { visibility: "story" },
        })}\n---\nTell the story.\n`,
      );
    }
    const [discovery] = await discoverPlugins(temp);
    const definition = await loadPluginDefinition(discovery!);
    expect(
      definition.manifests.map(({ manifest }) => [
        manifest.name,
        manifest.outputContract,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["teller/alpha", "narrative-engine@2"],
        ["teller/aside", undefined],
      ]),
    );
    expect(definition.manifests).toHaveLength(2);
    expect(definition.packageManifest.plugin.provides).toEqual([
      "narrative-engine@2",
    ]);
    expect(definition.disabledRuntimes).toHaveLength(1);
    expect(definition.disabledRuntimes[0]!.message).toMatch(
      /schedule\.trigger: teller\/zeta is a second automatically scheduled story runtime in this package, and teller\/alpha already provides narrative-engine@2/,
    );
    const validation = await validatePluginPackage(dir);
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "runtime-disabled",
        file: "runtimes/zeta/RUNTIME.md",
      }),
    );
  });
  it("accepts a package copy of the story schema and refuses a changed one", async () => {
    const story = {
      schedule: { stage: "narrative" },
      io: { visibility: "story" },
    };
    const root = {
      contracts: { "narrative-engine@2": { schema: "story.json" } },
    };
    const copy: Record<string, unknown> = {
      $id: "contract:narrative-engine@2",
      ...storyOutputJsonSchema(),
    };
    const accepted = await storyPackage(story, root, { "story.json": copy });
    expect(
      (await loadRuntime(accepted, "teller")).outputContractSchema,
    ).toEqual(storyContractSchema);
    const changed = await storyPackage(story, root, {
      "story.json": {
        ...copy,
        properties: {
          ...(copy.properties as Record<string, unknown>),
          extra: { type: "string" },
        },
      },
    });
    await expect(loadPluginDefinition(changed)).rejects.toThrow(
      /framework-owned/,
    );
  });
});
describe("framework actor contract", () => {
  it.each([undefined, "contract:character-actor@1"])(
    "loads the canonical schema with declaration %s",
    async (schema) => {
      const loaded = await loadRuntime(await fixture(schema), "sample");
      expect(loaded.outputSchema).toEqual(characterActorOutputJsonSchema());
      expect(resolveAgentOutput(loaded).schema).toEqual(
        characterActorOutputJsonSchema(),
      );
      expect(loaded.outputContractSchema).toEqual(
        characterActorOutputJsonSchema(),
      );
      expect(loaded.manifest.trigger).toEqual({ type: "manual" });
    },
  );
  it("retains canonical validation beside a weaker explicit schema", async () => {
    const loaded = await loadRuntime(await fixture("weak.json"), "sample");
    expect(loaded.outputContractSchema).toEqual(
      characterActorOutputJsonSchema(),
    );
  });
  it("prefers a convention schema over the actor default while retaining its contract", async () => {
    const discovery = await fixture();
    const schema = {
      type: "object",
      properties: { brief: { type: "string" } },
    };
    await fs.writeFile(
      path.join(discovery.rootPath, "output.schema.json"),
      JSON.stringify(schema),
    );
    const loaded = await loadRuntime(discovery, "sample");
    expect(resolveAgentOutput(loaded).schema).toEqual(schema);
    expect(loaded.outputContractSchema).toEqual(
      characterActorOutputJsonSchema(),
    );
  });
  it("refuses package schema shadowing", async () => {
    await expect(
      loadPluginDefinition(await fixture(undefined, true)),
    ).rejects.toThrow(/framework-owned/);
  });
  it.each([
    { schedule: {} },
    { schedule: { subagentOnly: true }, function: { handler: "run.ts" } },
    { schedule: { subagentOnly: true }, io: { visibility: "story" } },
  ])("rejects incompatible actor declarations %j", (extra) => {
    const declaration = {
      ...extra,
      io: {
        ...("io" in extra ? extra.io : {}),
        output: { contract: "character-actor@1" },
      },
    };
    expect(runtimeAuthoringManifestSchema.safeParse(declaration).success).toBe(
      false,
    );
  });
  it("reserves policy services for read access", () => {
    expect(
      serviceContributionSchema.safeParse({
        contract: "turn-policy@1",
        access: "write",
      }).success,
    ).toBe(false);
    expect(
      serviceContributionSchema.safeParse("character-actor@1").success,
    ).toBe(false);
    expect(serviceContributionSchema.safeParse("turn-policy@1").success).toBe(
      true,
    );
  });
});
