import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runRuntimeDebug } from "./runner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(hook: string, event: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "covel-debug-hooks-"));
  roots.push(root);
  const files = {
    "probe/package.json": '{"type":"module"}',
    "probe/PLUGIN.md": `---\nid: probe\nkind: plugin\ndescription: Probe\nruntime:\n  type: function\n  schedule: {trigger: {type: manual}}\n  function: {handler: ./handler.js}\n---\n`,
    "probe/handler.js":
      'export default async ctx => { await ctx.pluginData.set("notes", "current", "saved"); return {outcome:"success"}; };',
    "guard/package.json": '{"type":"module"}',
    "guard/PLUGIN.md": `---\nid: guard\nkind: plugin\ndescription: Hook only\nentry: ./entry.js\ncontributes:\n  settings:\n    - {key: mode, type: text, default: deny, label: Mode}\n  hooks:\n    - {event: ${event}}\n  actions: [inspect]\n  forms: [check]\n---\n`,
    "guard/entry.js": `export default covel => { covel.on(${JSON.stringify(event)}, ${hook}); covel.registerRpc("inspect", async () => ({})); covel.registerFormValidator("check", async () => undefined); };`,
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

it("runs a hook-only plugin inside the execution and commit scope with frozen settings", async () => {
  const root = await fixture(
    `async ctx => {
    const settings = ctx.getOwnSettings();
    if (!Object.isFrozen(settings) || settings.mode !== "deny") throw new Error("settings unavailable");
    return {action:"abort", reason:"guard denied commit"};
  }`,
    "PreStateCommit",
  );
  const report = await runRuntimeDebug({
    runtimeId: "probe",
    pluginsDir: root,
    withPlugins: ["guard"],
  });
  expect(report.commitStatus).toBe("failed");
  expect(report.commitError).toContain("guard denied commit");
  expect(report.pluginData.notes).toBeUndefined();
  expect(report.unsupportedCapabilities).toEqual([
    { pluginId: "guard", kind: "rpc", name: "inspect" },
    { pluginId: "guard", kind: "form-validator", name: "check" },
  ]);
});

it("reports lifecycle hooks that an isolated turn cannot execute", async () => {
  const root = await fixture(
    'async () => { throw new Error("must not run"); }',
    "SessionStart",
  );
  const report = await runRuntimeDebug({
    runtimeId: "probe",
    pluginsDir: root,
    withPlugins: ["guard"],
  });
  expect(report.commitStatus).toBe("committed");
  expect(report.unsupportedCapabilities).toContainEqual({
    pluginId: "guard",
    kind: "hook",
    name: "SessionStart",
  });
});

it("executes response hooks before publishing agent output", async () => {
  const root = await fixture(
    'async (_ctx, {response}) => ({action:"continue",replace:{response:{...response,content:"cleaned narrative"}}})',
    "PostLLMResponse",
  );
  await writeFile(
    path.join(root, "probe/PLUGIN.md"),
    "---\nid: probe\nkind: plugin\ndescription: Probe\nruntime:\n  type: agent\n  schedule: {trigger: {type: manual}}\n  io: {visibility: story}\n---\n",
    "utf8",
  );
  const report = await runRuntimeDebug({
    runtimeId: "probe",
    pluginsDir: root,
    withPlugins: ["guard"],
    llmContent: "raw narrative",
  });
  expect(report.runtimeResults[0]?.output).toMatchObject({
    narrativeOutput: "cleaned narrative",
  });
});

it.each(["null", '{match:"yes"}', "{timeoutMs:-1}", "{extra:true}"])(
  "rejects invalid hook options %s even if the entry catches registration errors",
  async (options) => {
    const root = await fixture("async()=>({action:'continue'})", "TurnStart");
    await writeFile(
      path.join(root, "guard/entry.js"),
      `export default covel => {
    covel.registerRpc("inspect",async()=>({})); covel.registerFormValidator("check",async()=>undefined);
    try {covel.on("TurnStart",async()=>({action:"continue"}),${options});} catch {}
  };`,
    );
    await expect(
      runRuntimeDebug({
        runtimeId: "probe",
        pluginsDir: root,
        withPlugins: ["guard"],
      }),
    ).rejects.toThrow("on:");
  },
);

it("reports server-only built-in extension points while retaining turn extensions", async () => {
  const root = await fixture("async()=>({action:'continue'})", "TurnStart");
  const points = [
    "history.compact@1",
    "ui.slot@1",
    "media.image-flow@1",
    "prompt.segment@1",
    "session.world-context@1",
    "prompt.history-transform@1",
  ];
  await writeFile(
    path.join(root, "guard/PLUGIN.md"),
    `---\nid: guard\nkind: plugin\ndescription: Extensions\nentry: ./entry.js\ncontributes:\n  extensions:\n${points.map((point, index) => `    - {point: ${point}, id: extension-${index}}`).join("\n")}\n---\n`,
  );
  await writeFile(
    path.join(root, "guard/entry.js"),
    `export default covel => {
    ${points.map((point, index) => `covel.provideExtension(${JSON.stringify(point)},"extension-${index}",{handler:async()=>${point === "prompt.segment@1" || point === "prompt.history-transform@1" ? "[]" : "({})"}});`).join("\n")}
  };`,
  );
  const report = await runRuntimeDebug({
    runtimeId: "probe",
    pluginsDir: root,
    withPlugins: ["guard"],
  });
  expect(report.unsupportedCapabilities).toEqual(
    points.slice(0, 3).map((point, index) => ({
      pluginId: "guard",
      kind: "extension",
      name: `${point}/extension-${index}`,
    })),
  );
  expect(report.commitStatus).toBe("committed");
});
