import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, type TestContext } from "vitest";
import {
  compileInlineRuntime,
  parsePluginMd,
  parseRuntimeMd,
} from "../src/parse-plugin-md.js";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";

const md = (value: object) => `---\n${JSON.stringify(value)}\n---\nPrompt`;
const plugin = { id: "probe", kind: "plugin", description: "Probe" };

async function fixture(
  layout: "inline" | "child",
  binding: object,
  onTestFinished: TestContext["onTestFinished"],
  files: Record<string, string> = {},
) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "covel-committed-cli-"));
  onTestFinished(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(await realpath(temp), "probe");
  const runtimeDir =
    layout === "inline" ? root : path.join(root, "runtimes/consumer");
  await mkdir(runtimeDir, { recursive: true });
  const runtime = {
    schedule: { trigger: { type: "manual" } },
    function: { handler: "./handler.js" },
    guard: "./guard.js",
    io: { inputs: { prior: binding } },
  };
  await writeFile(
    path.join(root, "PLUGIN.md"),
    md({
      ...plugin,
      entry: "./entry.js",
      ...(layout === "inline" ? { runtime } : {}),
    }),
  );
  if (layout === "child")
    await writeFile(path.join(runtimeDir, "RUNTIME.md"), md(runtime));
  // Importing or invoking any community module makes the test fail (or leaves the marker).
  const code = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(path.join(root, "executed"))}, 'executed'); throw new Error('Community code executed');`;
  await writeFile(path.join(root, "entry.js"), code);
  for (const name of ["handler.js", "guard.js"])
    await writeFile(path.join(runtimeDir, name), code);
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(runtimeDir, name), content);
  return {
    root,
    source: path.join(
      root,
      layout === "inline" ? "PLUGIN.md" : "runtimes/consumer/RUNTIME.md",
    ),
  };
}

async function cli(roots: string[], signal: AbortSignal) {
  const script = path.resolve(
    import.meta.dirname,
    "../scripts/validate-manifest.ts",
  );
  return new Promise<{ status: number; stderr: string; stdout: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        ["--import", "tsx", script, ...roots],
        { signal },
        (error, stdout, stderr) => {
          if (!error) resolve({ status: 0, stderr, stdout });
          else if (typeof error.code === "number")
            resolve({ status: error.code, stderr, stdout });
          else reject(error);
        },
      );
    },
  );
}

async function validate(root: string) {
  let stdout = "";
  let stderr = "";
  const status = await runValidateManifest([root], {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { status, stdout, stderr };
}

type ValidationCase = {
  name: string;
  binding: object;
  files: Record<string, string>;
};

const cases = (["inline", "child"] as const).map((layout) => {
  const runtimeId = layout === "inline" ? "probe" : "probe/consumer";
  const committed = {
    from: { runtime: runtimeId },
    scope: "committed",
    recordAs: "facts",
  };
  const invalid: (ValidationCase & { field: string })[] = [
    {
      name: "missing accepts",
      binding: { ...committed, accepts: "./missing.json" },
      field: "io.inputs.prior.accepts",
      files: {},
    },
    {
      name: "malformed accepts JSON",
      binding: { ...committed, accepts: "./invalid.json" },
      field: "io.inputs.prior.accepts",
      files: { "invalid.json": "not JSON" },
    },
    {
      name: "missing same-package producer",
      binding: { ...committed, from: { runtime: "probe/missing" } },
      field: "io.inputs.prior",
      files: {},
    },
    {
      name: "committed select",
      binding: { ...committed, select: "/value" },
      field: "io.inputs.prior.select",
      files: {},
    },
    {
      name: "committed empty select",
      binding: { ...committed, select: "" },
      field: "io.inputs.prior.select",
      files: {},
    },
  ];
  const valid: ValidationCase[] = [
    {
      name: "local committed schema",
      binding: { ...committed, accepts: "./valid.json" },
      files: { "valid.json": "{}" },
    },
    {
      name: "optional external committed contract",
      binding: {
        from: { contract: "external.output@1" },
        scope: "committed",
        recordAs: "facts",
        required: false,
        accepts: "contract:external.output@1",
      },
      files: {},
    },
    {
      name: "normal turn select",
      binding: {
        from: { runtime: runtimeId },
        select: "/value",
        accepts: "./valid.json",
      },
      files: { "valid.json": "{}" },
    },
  ];
  return { layout, runtimeId, committed, invalid, valid };
});

for (const { layout, runtimeId, committed, invalid, valid } of cases) {
  describe(`${layout} committed input static validation`, () => {
    it.for(invalid)(
      "rejects $name with the authored path without executing code",
      async ({ binding, field, files }, { onTestFinished }) => {
        const { root, source } = await fixture(
          layout,
          binding,
          onTestFinished,
          files,
        );
        const result = await validate(root);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(source);
        expect(result.stderr).toContain(field);
        await expect(access(path.join(root, "executed"))).rejects.toThrow();
      },
    );

    it.for(valid)(
      "accepts $name without executing code",
      async ({ binding, files }, { onTestFinished }) => {
        const { root } = await fixture(layout, binding, onTestFinished, files);
        const result = await validate(root);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(root);
        await expect(access(path.join(root, "executed"))).rejects.toThrow();
      },
    );

    it("parser rejects committed select and retains normal turn select", () => {
      const runtime = (binding: object) => ({
        schedule: { trigger: { type: "manual" } },
        io: { inputs: { prior: binding } },
      });
      const parse = (binding: object) =>
        layout === "inline"
          ? compileInlineRuntime(
              parsePluginMd(
                md({ ...plugin, runtime: runtime(binding) }),
                "probe/PLUGIN.md",
              ),
            )
          : parseRuntimeMd(
              md(runtime(binding)),
              "probe/runtimes/consumer/RUNTIME.md",
              parsePluginMd(md(plugin), "probe/PLUGIN.md").plugin,
            );
      expect(() => parse({ ...committed, select: "/value" })).toThrow(
        "io.inputs.prior.select",
      );
      expect(
        parse({ from: { runtime: runtimeId }, select: "/value" })?.manifest
          .inputs?.prior!.select,
      ).toBe("/value");
    });
  });
}

describe("committed input CLI batches", () => {
  it("rejects every invalid case in both layouts without executing code", async ({
    onTestFinished,
    signal,
  }) => {
    const fixtures: { root: string; source: string; field: string }[] = [];
    for (const { layout, invalid } of cases) {
      for (const { binding, field, files } of invalid) {
        fixtures.push({
          ...(await fixture(layout, binding, onTestFinished, files)),
          field,
        });
      }
    }
    const result = await cli(
      fixtures.map(({ root }) => root),
      signal,
    );
    expect.soft(result.status, result.stderr).toBe(1);
    for (const { root, source, field } of fixtures) {
      const diagnostic = result.stderr
        .split("\n")
        .filter((line) => line.includes(source))
        .join("\n");
      expect.soft(diagnostic, source).toContain(field);
      expect.soft(result.stdout).not.toContain(root);
      await expect.soft(access(path.join(root, "executed"))).rejects.toThrow();
    }
  });

  it("accepts every valid case in both layouts without executing code", async ({
    onTestFinished,
    signal,
  }) => {
    const roots: string[] = [];
    for (const { layout, valid } of cases) {
      for (const { binding, files } of valid) {
        const { root } = await fixture(layout, binding, onTestFinished, files);
        roots.push(root);
      }
    }
    const result = await cli(roots, signal);
    expect.soft(result.status, result.stderr).toBe(0);
    expect.soft(result.stderr).toBe("");
    for (const root of roots) {
      expect.soft(result.stdout).toContain(root);
      await expect.soft(access(path.join(root, "executed"))).rejects.toThrow();
    }
  });
});
