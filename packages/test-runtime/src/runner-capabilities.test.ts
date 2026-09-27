import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CharacterAttributeSchema } from "@covel/shared";
import { runRuntimeDebug } from "./runner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const schema = {
  version: 1,
  attributes: [
    {
      id: "hp",
      name: "HP",
      type: "number",
      category: "stats",
      defaultValue: 10,
      min: 0,
      max: 100,
    },
  ],
} satisfies CharacterAttributeSchema;

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "covel-harness-capabilities-"),
  );
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

function runtime(name: string, extra = "") {
  return `---\nname: ${name}\ndescription: Fixture\nruntimeType: function\nhandler: ./handler.js\ntrigger: {type: manual}\n${extra}---\n`;
}

async function providerFixture(
  capability: "package" | "runtime" | "none",
  invalid = false,
) {
  const declaration = "capabilities: [world-data-provider]\n";
  return fixture({
    "probe/package.json": '{"type":"module"}',
    "probe/PLUGIN.md": "---\nname: probe\ndescription: Probe\n---\n",
    "probe/runtimes/root/PLUGIN.md": runtime("probe/root"),
    "probe/runtimes/root/handler.js":
      'export default async () => ({outcome: "success", effects: {events: [{topic: "root.ready", data: {}}]}});',
    "support/package.json": '{"type":"module"}',
    "support/PLUGIN.md": `---\nname: support\ndescription: Support\n${capability === "package" ? declaration : ""}---\n`,
    "support/runtimes/follower/PLUGIN.md": `---\nname: support/follower\ndescription: Support follower\nruntimeType: function\nhandler: ./handler.js\ntrigger: {type: event, topic: root.ready}\nexecution: background\ntools: {builtin: [get-character-schema, create-character, get-character]}\n${capability === "runtime" ? declaration : ""}---\n`,
    "support/runtimes/follower/handler.js": `export default async ctx => {
      await ctx.pluginData.set("schema", "character-attributes", ${JSON.stringify(schema)});
      const result = await ctx.tools.call("get-character-schema", {});
      await ctx.tools.call("create-character", {name: "Test player", type: "player", fields: ${invalid ? '{hp: "invalid"}' : "{}"}});
      const character = await ctx.tools.call("get-character", {name: "Test player"});
      return {outcome: "success", value: {schema: result.schema, fields: character.character.fields}};
    };`,
  });
}

describe("runtime debug capability providers", () => {
  it.each(["package", "runtime"] as const)(
    "uses a selected %s provider for schemas and character defaults",
    async (capability) => {
      const root = await providerFixture(capability);
      const report = await runRuntimeDebug({
        runtimeId: "probe/root",
        pluginsDir: root,
        withPlugins: ["support"],
      });
      expect(
        report.runtimeResults.find(
          ({ runtimeId }) => runtimeId === "support/follower",
        ),
      ).toMatchObject({
        status: "success",
        output: { schema, fields: { hp: 10 } },
      });
      expect(report.jobs).toMatchObject([{ status: "done" }]);
    },
  );

  it("enforces the support provider's field constraints", async () => {
    const root = await providerFixture("package", true);
    const report = await runRuntimeDebug({
      runtimeId: "probe/root",
      pluginsDir: root,
      withPlugins: ["support"],
    });
    expect(
      report.runtimeResults.find(
        ({ runtimeId }) => runtimeId === "support/follower",
      ),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining(
        "Character attributes do not match the world schema: hp",
      ),
    });
    expect(report.jobs).toMatchObject([{ status: "failed" }]);
  });

  it("does not infer a provider from schema data without a capability", async () => {
    const root = await providerFixture("none");
    const report = await runRuntimeDebug({
      runtimeId: "probe/root",
      pluginsDir: root,
      withPlugins: ["support"],
    });
    expect(
      report.runtimeResults.find(
        ({ runtimeId }) => runtimeId === "support/follower",
      ),
    ).toMatchObject({
      status: "success",
      output: { schema: null, fields: {} },
    });
  });

  it("rejects competing runtime providers under the host's fallback rules", async () => {
    const files: Record<string, string> = {
      "probe/package.json": '{"type":"module"}',
      "probe/PLUGIN.md": runtime(
        "probe",
        "tools: {builtin: [get-character-schema]}\n",
      ),
      "probe/handler.js":
        'export default async ctx => ({outcome: "success", value: await ctx.tools.call("get-character-schema", {})});',
    };
    for (const id of ["fallback", "first", "second"]) {
      files[`${id}/package.json`] = '{"type":"module"}';
      files[`${id}/PLUGIN.md`] = runtime(
        id,
        `capabilities: [world-data-provider]\n${id === "fallback" ? "fallbackFor: world-data-provider\n" : ""}`,
      );
      files[`${id}/handler.js`] =
        'export default async () => ({outcome: "success", value: null});';
    }
    const root = await fixture(files);
    const report = await runRuntimeDebug({
      runtimeId: "probe",
      pluginsDir: root,
      withPlugins: ["fallback", "first", "second"],
    });
    expect(report.runtimeResults[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining(
        "Multiple active providers for world-data-provider",
      ),
    });
  });
});
