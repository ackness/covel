import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CharacterSchema } from "@covel/shared";
import { runRuntimeDebug } from "./runner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const schema = {
  version: 1,
  types: ["npc", "companion"],
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
} satisfies CharacterSchema;

async function fixture(
  mode: "buffered" | "committed" | "private",
  invalid = false,
) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "covel-harness-world-model-"),
  );
  roots.push(root);
  const schemaTool = `export default covel => {
    covel.registerTool(covel.toolkit.tool({
      name: "set-schema", description: "Set fixture schema", parameters: covel.toolkit.z.object({}),
      execute: async (_args, ctx) => covel.toolkit.withPendingProposals({ok:true}, [{
        id: crypto.randomUUID(), type:"character.schema.set", payload:${JSON.stringify({ types: schema.types, attributes: schema.attributes })},
        sessionId:ctx.sessionId, turnId:ctx.turnId,
        source:{pluginId:ctx.pluginId,runtimeId:ctx.runtimeId}, timestamp:new Date().toISOString()
      }])
    }));
  };`;
  const files: Record<string, string> = {
    "probe/package.json": '{"type":"module"}',
    "probe/PLUGIN.md": `---\nid: probe\nkind: plugin\ndescription: Probe\n${mode === "committed" ? "entry: ./entry.js\ncontributes: {tools: [set-schema]}\n" : ""}---\n`,
    "probe/entry.js": schemaTool,
    "probe/runtimes/root/RUNTIME.md": `---\ntype: function\nfunction: {handler: ./handler.js${mode === "committed" ? ", tools: {plugin: [set-schema]}" : ""}}\nschedule: {trigger: {type: manual}}\n---\n`,
    "probe/runtimes/root/handler.js": `export default async ctx => {
      ${mode === "committed" ? 'await ctx.tools.call("set-schema", {});' : ""}
      return {outcome:"success",effects:{events:[{topic:"root.ready",data:{}}]}};
    };`,
    "support/package.json": '{"type":"module"}',
    "support/PLUGIN.md": `---\nid: support\nkind: plugin\ndescription: Support\n${mode === "buffered" ? "entry: ./entry.js\ncontributes: {tools: [set-schema]}\n" : ""}---\n`,
    "support/entry.js": schemaTool,
    "support/runtimes/follower/RUNTIME.md": `---
type: function
function:
  handler: ./handler.js
  tools:
    builtin: [get-character-schema, create-character, get-character]
    plugin: ${mode === "buffered" ? "[set-schema]" : "[]"}
schedule:
  trigger: {type: event, topic: root.ready}
  manual: {execution: background}
---
`,
    "support/runtimes/follower/handler.js": `export default async ctx => {
      ${mode === "buffered" ? 'await ctx.tools.call("set-schema", {});' : ""}
      ${mode === "private" ? `await ctx.pluginData.set("schema", "character-attributes", ${JSON.stringify(schema)});` : ""}
      const result = await ctx.tools.call("get-character-schema", {});
      await ctx.tools.call("create-character", {name:"Test player",type:"player",fields:${invalid ? '{hp:"invalid"}' : "{}"}});
      const character = await ctx.tools.call("get-character", {name:"Test player"});
      return {outcome:"success",value:{schema:result.schema,fields:character.character.fields,worldSchema:ctx.world.characterSchema}};
    };`,
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

describe("runtime debug World Model", () => {
  it.each(["buffered", "committed"] as const)(
    "uses %s domain schema for character defaults",
    async (mode) => {
      const root = await fixture(mode);
      const report = await runRuntimeDebug({
        runtimeId: "probe/root",
        pluginsDir: root,
        withPlugins: ["support"],
      });
      expect(
        report.runtimeResults.find(
          (result) => result.runtimeId === "support/follower",
        ),
        JSON.stringify(report.runtimeResults),
      ).toMatchObject({
        status: "success",
        output: { schema, fields: { hp: 10 }, worldSchema: schema },
      });
      expect(report.jobs).toMatchObject([{ status: "done" }]);
    },
  );

  it("enforces domain schema constraints before committing character writes", async () => {
    const root = await fixture("committed", true);
    const report = await runRuntimeDebug({
      runtimeId: "probe/root",
      pluginsDir: root,
      withPlugins: ["support"],
    });
    expect(
      report.runtimeResults.find(
        (result) => result.runtimeId === "support/follower",
      ),
      JSON.stringify(report.runtimeResults),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining(
        "Character attributes do not match the world schema: hp",
      ),
    });
    expect(report.jobs).toMatchObject([{ status: "failed" }]);
  });

  it("does not infer a domain schema from a plugin's private schema data", async () => {
    const root = await fixture("private");
    const report = await runRuntimeDebug({
      runtimeId: "probe/root",
      pluginsDir: root,
      withPlugins: ["support"],
    });
    expect(
      report.runtimeResults.find(
        (result) => result.runtimeId === "support/follower",
      ),
      JSON.stringify(report.runtimeResults),
    ).toMatchObject({
      status: "success",
      output: { schema: null, fields: {}, worldSchema: null },
    });
  });
});
