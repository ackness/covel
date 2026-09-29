import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
    "---\nid: probe\nkind: plugin\ndescription: Probe\n---\n",
    "utf8",
  );
  return { root, pluginRoot };
}

async function runtimeFixture(
  pluginRoot: string,
  name: string,
  handler: string,
  extra = "schedule: {trigger: {type: manual}}",
  functionOptions = "",
) {
  const directory = path.join(pluginRoot, "runtimes", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "RUNTIME.md"),
    `---\ntype: function\ndescription: Probe\nfunction: {handler: ./handler.js${functionOptions}}\n${extra}\n---\n`,
    "utf8",
  );
  await writeFile(
    path.join(directory, "handler.js"),
    `export default async function(ctx) {\n${handler}\n}\n`,
    "utf8",
  );
}

describe("runtime debug host integration", () => {
  it("loads an explicit entry-only provider for API, cases, and repeatable CLI options", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "covel-runtime-composition-"),
    );
    roots.push(root);
    const fixtures = path.resolve(
      import.meta.dirname,
      "../../../tests/third-party",
    );
    for (const id of ["lifecycle-probe", "service-provider-probe"]) {
      await cp(path.join(fixtures, id), path.join(root, id), {
        recursive: true,
      });
    }
    const options = {
      runtimeId: "lifecycle-probe/note",
      pluginsDir: root,
      withPlugins: [
        "service-provider-probe",
        "service-provider-probe",
        "lifecycle-probe",
      ],
      payload: {
        key: "composed",
        text: "hello",
        providerPluginId: "service-provider-probe",
      },
    };
    const result = await runRuntimeDebug(options);
    expect(result.runtimeResults.map(({ runtimeId }) => runtimeId)).toEqual([
      "lifecycle-probe/note",
    ]);
    expect(result.pluginData.notes).toMatchObject([
      { key: "composed", value: { text: "[formatted] hello" } },
    ]);
    expect(result.llmCalls).toEqual([]);

    await mkdir(path.join(root, "lifecycle-probe", "tests"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "lifecycle-probe", "tests", "runtime-cases.json"),
      JSON.stringify({
        cases: [
          {
            name: "composed",
            runtimeId: "lifecycle-probe/note",
            withPlugins: ["service-provider-probe"],
            payload: options.payload,
            expect: {
              runtimeResults: [
                { runtimeId: "lifecycle-probe/note", status: "success" },
              ],
            },
          },
        ],
      }),
      "utf8",
    );
    const cases = await runRuntimeCases({
      pluginId: "lifecycle-probe",
      pluginsDir: root,
    });
    expect(cases.cases[0]?.status).toBe("passed");
    expect(cases.cases[0]?.result.pluginData.notes?.[0]?.value).toMatchObject({
      text: "[formatted] hello",
    });
    const cli = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(import.meta.dirname, "cli.ts"),
        "lifecycle-probe/note",
        "--plugins-dir",
        root,
        "--with-plugin",
        "service-provider-probe",
        "--with-plugin",
        "service-provider-probe",
        "--payload",
        JSON.stringify(options.payload),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout).pluginData.notes[0].value.text).toBe(
      "[formatted] hello",
    );
  }, 20_000);

  it("does not discover an unselected or missing provider", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "covel-runtime-composition-"),
    );
    roots.push(root);
    const fixtures = path.resolve(
      import.meta.dirname,
      "../../../tests/third-party",
    );
    await cp(
      path.join(fixtures, "lifecycle-probe"),
      path.join(root, "lifecycle-probe"),
      { recursive: true },
    );
    const options = {
      runtimeId: "lifecycle-probe/note",
      pluginsDir: root,
      payload: { providerPluginId: "service-provider-probe" },
    };
    const without = await runRuntimeDebug(options);
    expect(without.runtimeResults).toMatchObject([{ status: "failed" }]);
    expect(without.pluginData.notes ?? []).toEqual([]);
    await expect(
      runRuntimeDebug({ ...options, withPlugins: ["service-provider-probe"] }),
    ).rejects.toThrow('plugin "service-provider-probe" not found');
    await cp(
      path.join(fixtures, "service-provider-probe"),
      path.join(root, "service-provider-probe"),
      { recursive: true },
    );
    const stillUnselected = await runRuntimeDebug(options);
    expect(stillUnselected.runtimeResults).toMatchObject([
      { status: "failed" },
    ]);
    expect(stillUnselected.pluginData.notes ?? []).toEqual([]);
  });

  it("disposes the first entry when a later selected entry fails", async () => {
    const { root, pluginRoot } = await pluginFixture();
    const marker = path.join(root, "disposed.txt");
    await writeFile(
      path.join(pluginRoot, "PLUGIN.md"),
      "---\nid: probe\nkind: plugin\ndescription: Probe\nentry: ./entry.js\n---\n",
      "utf8",
    );
    await writeFile(
      path.join(pluginRoot, "entry.js"),
      `export default covel => { covel.onDispose(async () => {
        await (await import("node:fs/promises")).writeFile(${JSON.stringify(marker)}, String(covel.signal.aborted));
      }); };`,
      "utf8",
    );
    await runtimeFixture(
      pluginRoot,
      "root",
      'return {outcome: "success", value: null};',
    );
    await expect(
      runRuntimeDebug({
        runtimeId: "probe/root",
        pluginsDir: root,
        withPlugins: ["missing"],
      }),
    ).rejects.toThrow('plugin "missing" not found');
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const support = path.join(root, "support");
    await mkdir(support);
    await writeFile(
      path.join(support, "package.json"),
      '{"type":"module"}',
      "utf8",
    );
    await writeFile(
      path.join(support, "PLUGIN.md"),
      "---\nid: support\nkind: plugin\ndescription: Support\nentry: ./entry.js\n---\n",
      "utf8",
    );
    await writeFile(
      path.join(support, "entry.js"),
      'export default () => { throw new Error("support init failed"); };',
      "utf8",
    );
    await expect(
      runRuntimeDebug({
        runtimeId: "probe/root",
        pluginsDir: root,
        withPlugins: ["support"],
      }),
    ).rejects.toThrow("support init failed");
    expect(await readFile(marker, "utf8")).toBe("true");
  });

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
      "schedule: {trigger: {type: event, topic: root.ready}, manual: {execution: background}}",
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
  it.each([
    {
      mode: "skipped-follower",
      jobStatus: "done",
      caseStatus: "passed",
      exitCode: 0,
    },
    {
      mode: "missing-follower",
      jobStatus: "failed",
      caseStatus: "failed",
      exitCode: 1,
    },
  ])(
    "reports $mode job and CLI outcomes",
    async ({ mode, jobStatus, caseStatus, exitCode }) => {
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
          "schedule: {trigger: {type: event, topic: root.ready}, manual: {execution: background}}",
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
      ).toBe(jobStatus === "failed");
      expect(cases.cases[0]?.result.jobs).toContainEqual(
        expect.objectContaining({ status: jobStatus }),
      );
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
      expect(cli.status, cli.stderr).toBe(exitCode);
      expect(cases.cases[0]?.status).toBe(caseStatus);
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
      "schedule: {trigger: {type: event, topic: root.ready}, manual: {execution: background}}",
      ", tools: {builtin: [plugin-data-set]}",
    );
    await runtimeFixture(
      pluginRoot,
      "next",
      `
      await ctx.pluginData.set("notes", "next", {shouldNotRun: true});
      return {outcome: "success", value: null};
    `,
      "schedule: {trigger: {type: event, topic: next.ready}, manual: {execution: background}}",
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

  it("preserves per-plugin settings across followers and cross-plugin recursion", async () => {
    const { root, pluginRoot } = await pluginFixture();
    await writeFile(
      path.join(pluginRoot, "PLUGIN.md"),
      "---\nid: probe\nkind: plugin\ndescription: Probe\ncontributes:\n  settings:\n    - key: count\n      type: number\n      label: Count\n      default: 1\n---\n",
      "utf8",
    );
    await runtimeFixture(
      pluginRoot,
      "root",
      'return {outcome: "success", effects: {events: [{topic: "root.ready", data: {}}]}};',
    );
    await runtimeFixture(
      pluginRoot,
      "follower",
      'return {outcome: "success", value: {count: ctx.userSettings.count}};',
      "schedule: {trigger: {type: event, topic: root.ready}, manual: {execution: background}}",
    );
    await runtimeFixture(
      pluginRoot,
      "child",
      'return {outcome: "success", value: {count: ctx.userSettings.count}};',
    );

    const supportRoot = path.join(root, "support");
    await mkdir(path.join(supportRoot, "runtimes", "follower"), {
      recursive: true,
    });
    await writeFile(
      path.join(supportRoot, "package.json"),
      '{"type":"module"}',
      "utf8",
    );
    await writeFile(
      path.join(supportRoot, "PLUGIN.md"),
      "---\nid: support\nkind: plugin\ndescription: Support\ncontributes:\n  settings:\n    - key: count\n      type: number\n      label: Count\n      default: 10\n---\n",
      "utf8",
    );
    await writeFile(
      path.join(supportRoot, "runtimes", "follower", "RUNTIME.md"),
      "---\ntype: function\ndescription: Support follower\nfunction: {handler: ./handler.js}\nschedule: {trigger: {type: event, topic: root.ready}, manual: {execution: background}}\n---\n",
      "utf8",
    );
    await writeFile(
      path.join(supportRoot, "runtimes", "follower", "handler.js"),
      'export default async function(ctx) { await ctx.recursiveCall({manualTrigger: {runtimeId: "probe/child"}}); return {outcome: "success", value: {count: ctx.userSettings.count}}; }\n',
      "utf8",
    );

    const report = await runRuntimeDebug({
      runtimeId: "probe/root",
      pluginsDir: root,
      withPlugins: ["support"],
      userSettings: { count: 99 },
    });
    expect(report.jobs).toMatchObject([
      { runtimeId: "probe/follower", status: "done" },
      { runtimeId: "support/follower", status: "done" },
    ]);
    expect(
      Object.fromEntries(
        report.runtimeResults
          .filter(({ runtimeId }) => runtimeId.endsWith("/follower"))
          .map(({ runtimeId, output }) => [runtimeId, output?.count]),
      ),
    ).toEqual({ "probe/follower": 99, "support/follower": 10 });
    expect(
      report.runtimeResults.find(({ runtimeId }) => runtimeId === "probe/child")
        ?.output,
    ).toEqual({ count: 99 });
  });

  it.each([false, true])(
    "stops entry-owned workers before draining timed-out tools (cleanup error: %s)",
    async (cleanupFails) => {
      const { root, pluginRoot } = await pluginFixture();
      await writeFile(
        path.join(pluginRoot, "PLUGIN.md"),
        "---\nid: probe\nkind: plugin\ndescription: Probe\nentry: ./entry.js\ncontributes: {tools: [wait-for-worker]}\n---\n",
        "utf8",
      );
      const entryPath = path.join(pluginRoot, "entry.js");
      await writeFile(
        entryPath,
        `export const state = {disposed: false, drained: false, aborted: false};
        let finish;
        export function release() { finish?.({stopped: true}); }
        export default covel => {
          const work = new Promise(resolve => { finish = resolve; });
          covel.onDispose(() => {
            state.disposed = true;
            state.aborted = covel.signal.aborted;
            release();
            if (${cleanupFails}) throw new Error("worker cleanup failed");
          });
          covel.registerTool(covel.toolkit.tool({
            name: "wait-for-worker", description: "Wait for an entry-owned worker",
            parameters: covel.toolkit.z.object({}),
            execute: async () => {
              const result = await work;
              await new Promise(resolve => setTimeout(resolve, 10));
              state.drained = true;
              return result;
            },
          }));
        };`,
        "utf8",
      );
      await runtimeFixture(
        pluginRoot,
        "root",
        'await ctx.tools.call("wait-for-worker", {}); return {outcome: "success", value: null};',
        "schedule: {trigger: {type: manual}}",
        ", timeoutMs: 20, tools: {plugin: [wait-for-worker]}",
      );
      const entry = (await import(
        pathToFileURL(await realpath(entryPath)).href
      )) as {
        state: { disposed: boolean; drained: boolean; aborted: boolean };
        release(): void;
      };
      const running = runRuntimeDebug({
        runtimeId: "probe/root",
        pluginsDir: root,
      });
      const settled = running.then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          settled,
          new Promise<"blocked">((resolve) => {
            timer = setTimeout(() => resolve("blocked"), 2_000);
          }),
        ]);
        expect(outcome).not.toBe("blocked");
        expect(entry.state).toEqual({
          disposed: true,
          drained: true,
          aborted: true,
        });
        if (outcome === "blocked") return;
        if (cleanupFails) {
          expect(outcome.error).toMatchObject({
            errors: [
              expect.objectContaining({ message: "worker cleanup failed" }),
            ],
          });
        } else {
          expect(outcome.error).toBeUndefined();
          expect(outcome.result?.runtimeResults[0]).toMatchObject({
            status: "failed",
            error: expect.stringContaining("timed out after 20ms"),
          });
        }
      } finally {
        clearTimeout(timer);
        // Release the fixture even when the old shutdown ordering regresses.
        entry.release();
        await settled;
      }
    },
  );

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
      "schedule: {trigger: {type: event, topic: root.ready}, manual: {execution: background}}",
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

  it("releases entry resources after repeated runs and a runner failure", async () => {
    const { root, pluginRoot } = await pluginFixture();
    const marker = path.join(pluginRoot, "closed.txt");
    await writeFile(
      path.join(pluginRoot, "PLUGIN.md"),
      "---\nid: probe\nkind: plugin\ndescription: Probe\nentry: ./entry.js\n---\n",
      "utf8",
    );
    await writeFile(
      path.join(pluginRoot, "entry.js"),
      `let activations = 0;
      export default covel => {
        activations++;
        const activation = activations;
        covel.onDispose(async () => {
          await (await import("node:fs/promises")).appendFile(${JSON.stringify(marker)}, String(covel.signal.aborted) + "\\n");
          if (activation === 3) throw new Error("cleanup failed");
        });
      };`,
      "utf8",
    );
    await runtimeFixture(
      pluginRoot,
      "root",
      'return {outcome: "success", value: null};',
    );

    for (let i = 0; i < 2; i++) {
      await runRuntimeDebug({ runtimeId: "probe/root", pluginsDir: root });
    }
    const failure = await runRuntimeDebug({
      runtimeId: "probe/root",
      pluginsDir: root,
      userSettings: { invalid: () => {} },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      cause: expect.objectContaining({ name: "DataCloneError" }),
      errors: [
        expect.objectContaining({ name: "DataCloneError" }),
        expect.objectContaining({ message: "cleanup failed" }),
      ],
    });
    expect((failure as AggregateError).message).toBe(
      ((failure as AggregateError).cause as Error).message,
    );
    expect(await readFile(marker, "utf8")).toBe("true\ntrue\ntrue\n");
  });
});
