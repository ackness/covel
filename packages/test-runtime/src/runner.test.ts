import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runRuntimeCases, runRuntimeDebug } from "./runner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function pluginFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "covel-runtime-debug-"));
  roots.push(root);
  const pluginRoot = path.join(root, "probe");
  await mkdir(pluginRoot);
  await writeFile(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({ type: "module" }),
    "utf8",
  );
  await writeFile(
    path.join(pluginRoot, "PLUGIN.md"),
    "---\nname: probe\ndescription: Probe\n---\n",
    "utf8",
  );
  return { root, pluginRoot };
}

async function runtimeFixture(
  pluginRoot: string,
  name: string,
  handler: string,
  extra = "trigger: {type: manual}",
) {
  const directory = path.join(pluginRoot, "runtimes", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "PLUGIN.md"),
    `---\nname: probe/${name}\ndescription: Probe\nruntimeType: function\nhandler: ./handler.js\n${extra}\n---\n`,
    "utf8",
  );
  await writeFile(
    path.join(directory, "handler.js"),
    `export default async function(ctx) {\n${handler}\n}\n`,
    "utf8",
  );
}

describe("runtime debug host integration", () => {
  it("allows a case to expect the failure of its matching follower", async () => {
    const { root, pluginRoot } = await pluginFixture();
    await runtimeFixture(
      pluginRoot,
      "root",
      'return {outcome: "success", effects: {events: [{topic: "root.ready", data: {}}]}};',
    );
    await runtimeFixture(
      pluginRoot,
      "follower",
      'return {outcome: "failed", error: "expected provider failure"};',
      "trigger: {type: event, topic: root.ready}\nexecution: background",
    );
    await mkdir(path.join(pluginRoot, "tests"));
    await writeFile(
      path.join(pluginRoot, "tests/runtime-cases.json"),
      JSON.stringify({
        cases: [
          {
            name: "expected-failure",
            runtimeId: "probe/root",
            expect: {
              runtimeResults: [
                {
                  runtimeId: "probe/follower",
                  status: "failed",
                  errorIncludes: "expected provider failure",
                },
              ],
            },
          },
        ],
      }),
      "utf8",
    );
    const report = await runRuntimeCases({
      pluginId: "probe",
      pluginsDir: root,
    });
    expect(report.cases[0]?.result.jobs).toMatchObject([
      { runtimeId: "probe/follower", status: "failed" },
    ]);
    expect(report.cases[0]?.status).toBe("passed");
  });

  // CLI cases include a fresh Node/tsx import graph. Keep the outer budget
  // above the child's 10-second hard limit, including setup on loaded CI hosts.
  it.each(["skipped-follower", "missing-follower"])(
    "fails cases and CLI when the job fails without a failed runtime (%s)",
    async (mode) => {
      const { root, pluginRoot } = await pluginFixture();
      await runtimeFixture(
        pluginRoot,
        "root",
        mode === "skipped-follower"
          ? 'return {outcome: "success", effects: {events: [{topic: "root.ready", data: {}}]}};'
          : 'return {outcome: "success", value: null};',
      );
      if (mode === "skipped-follower") {
        await runtimeFixture(
          pluginRoot,
          "follower",
          'return {outcome: "skipped", skipReason: "nothing to do"};',
          "trigger: {type: event, topic: root.ready}\nexecution: background",
        );
      }
      await mkdir(path.join(pluginRoot, "tests"));
      await writeFile(
        path.join(pluginRoot, "tests/runtime-cases.json"),
        JSON.stringify({
          cases: [
            {
              name: mode,
              runtimeId: "probe/root",
              expectsBackgroundFollower: true,
            },
          ],
        }),
        "utf8",
      );
      const cases = await runRuntimeCases({
        pluginId: "probe",
        pluginsDir: root,
      });
      expect(
        cases.cases[0]?.result.runtimeResults.some(
          (result) => result.status === "failed",
        ),
      ).toBe(false);
      expect(
        cases.cases[0]?.result.jobs.some((job) => job.status === "failed"),
      ).toBe(true);
      const cli = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(import.meta.dirname, "cli.ts"),
          "probe/root",
          "--plugins-dir",
          root,
          "--expects-background-follower",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(cli.status, cli.stderr).toBe(1);
      expect(cases.cases[0]?.status).toBe("failed");
    },
    15_000,
  );

  it("commits and reports nested results from the initial runtime", async () => {
    const { root, pluginRoot } = await pluginFixture();
    await runtimeFixture(
      pluginRoot,
      "root",
      `
      await ctx.recursiveCall({manualTrigger: {runtimeId: "probe/child"}});
      await ctx.pluginData.set("notes", "root", {ok: true});
      return {outcome: "success", value: null};
    `,
    );
    await runtimeFixture(
      pluginRoot,
      "child",
      `
      await ctx.pluginData.set("notes", "child", {ok: true});
      return {outcome: "success", value: null};
    `,
    );
    const report = await runRuntimeDebug({
      runtimeId: "probe/root",
      pluginsDir: root,
    });
    expect(
      report.runtimeResults.map((result) => result.runtimeId).sort(),
    ).toEqual(["probe/child", "probe/root"]);
    expect(report.pluginData.notes?.map((row) => row.key).sort()).toEqual([
      "child",
      "root",
    ]);
    expect(report.commitStatus).toBe("committed");
  });

  it("shares governed tools with the first follower and reports further work without executing it", async () => {
    const { root, pluginRoot } = await pluginFixture();
    await runtimeFixture(
      pluginRoot,
      "root",
      `
      return {outcome: "success", effects: {events: [{topic: "root.ready", data: {source: "root"}}]}};
    `,
    );
    await runtimeFixture(
      pluginRoot,
      "follower",
      `
      await ctx.tools.call("plugin-data-set", {namespace: "notes", key: "follower", value: ctx.triggerEvent.data});
      return {outcome: "success", effects: {events: [{topic: "next.ready", data: {source: "follower"}}]}};
    `,
      "trigger: {type: event, topic: root.ready}\nexecution: background\ntools: {builtin: [plugin-data-set]}",
    );
    await runtimeFixture(
      pluginRoot,
      "next",
      `
      await ctx.pluginData.set("notes", "next", {shouldNotRun: true});
      return {outcome: "success", value: null};
    `,
      "trigger: {type: event, topic: next.ready}\nexecution: background",
    );
    const report = await runRuntimeDebug({
      runtimeId: "probe/root",
      pluginsDir: root,
    });
    expect(report.jobs).toMatchObject([
      { runtimeId: "probe/follower", status: "done" },
    ]);
    expect(report.pluginData.notes).toEqual([
      { key: "follower", value: { source: "root" } },
    ]);
    expect(report.pendingDeferredFollowers).toEqual([
      {
        runtimeId: "probe/next",
        pluginId: "probe",
        triggerEvent: { topic: "next.ready", data: { source: "follower" } },
      },
    ]);
    expect(report.runtimeResults.map((result) => result.runtimeId)).toEqual([
      "probe/root",
      "probe/follower",
    ]);
  });

  it("rolls back the root and nested writes and does not run followers when a proposal fails", async () => {
    const { root, pluginRoot } = await pluginFixture();
    await runtimeFixture(
      pluginRoot,
      "root",
      `
      await ctx.recursiveCall({manualTrigger: {runtimeId: "probe/child"}});
      await ctx.pluginData.set("notes", "root", {mustRollback: true});
      return {outcome: "success", effects: {events: [{topic: "", data: {}}, {topic: "root.ready", data: {}}]}};
    `,
    );
    await runtimeFixture(
      pluginRoot,
      "child",
      `
      await ctx.pluginData.set("notes", "child", {mustRollback: true});
      return {outcome: "success", value: null};
    `,
    );
    await runtimeFixture(
      pluginRoot,
      "follower",
      `
      await ctx.pluginData.set("notes", "follower", {mustNotRun: true});
      return {outcome: "success", value: null};
    `,
      "trigger: {type: event, topic: root.ready}\nexecution: background",
    );
    const report = await runRuntimeDebug({
      runtimeId: "probe/root",
      pluginsDir: root,
    });
    expect(report.commitStatus).toBe("failed");
    expect(report.commitError).toBeTruthy();
    expect(report.pluginData.notes ?? []).toEqual([]);
    expect(report.jobs).toEqual([]);
    expect(report.deferredFollowers).toEqual([]);
    expect(report.pendingDeferredFollowers).toEqual([]);
    await mkdir(path.join(pluginRoot, "tests"));
    await writeFile(
      path.join(pluginRoot, "tests/runtime-cases.json"),
      JSON.stringify({
        cases: [
          {
            name: "commit-failure",
            runtimeId: "probe/root",
            expect: {
              runtimeResults: [{ runtimeId: "probe/root", status: "success" }],
            },
          },
        ],
      }),
      "utf8",
    );
    const cases = await runRuntimeCases({
      pluginId: "probe",
      pluginsDir: root,
    });
    expect(cases.cases[0]?.status).toBe("failed");
    const cli = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(import.meta.dirname, "cli.ts"),
        "probe/root",
        "--plugins-dir",
        root,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(cli.status, cli.stderr).toBe(1);
    expect(JSON.parse(cli.stdout).commitStatus).toBe("failed");
  }, 15_000);
});
