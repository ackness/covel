import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileInlineRuntime,
  parsePluginMd,
  parseRuntimeMd,
} from "../src/parse-plugin-md.js";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";

const md = (value: object) => `---\n${JSON.stringify(value)}\n---\nPrompt`;
const plugin = { id: "probe", kind: "plugin", description: "Probe" };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  layout: "inline" | "child",
  binding: object,
  files: Record<string, string> = {},
) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "covel-committed-cli-"));
  roots.push(temp);
  const root = path.join(temp, "probe");
  const runtimeDir =
    layout === "inline" ? root : path.join(root, "runtimes/consumer");
  await mkdir(runtimeDir, { recursive: true });
  const runtime = {
    type: "function",
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
      optional: ["external.output@1"],
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
    source: layout === "inline" ? "PLUGIN.md" : "runtimes/consumer/RUNTIME.md",
  };
}

async function cli(root: string, signal: AbortSignal) {
  const script = path.resolve(
    import.meta.dirname,
    "../scripts/validate-manifest.ts",
  );
  return new Promise<{ status: number; stderr: string; stdout: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        ["--import", "tsx", script, root],
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

for (const layout of ["inline", "child"] as const) {
  const runtimeId = layout === "inline" ? "probe" : "probe/consumer";
  const committed = {
    from: { runtime: runtimeId },
    scope: "committed",
    recordAs: "facts",
  };
  describe(`${layout} committed input static validation`, () => {
    it.for<{
      name: string;
      binding: object;
      field: string;
      files: Record<string, string>;
    }>([
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
    ])(
      "CLI rejects $name with the authored path without executing code",
      async ({ binding, field, files }, { signal }) => {
        const { root, source } = await fixture(layout, binding, files);
        const result = await cli(root, signal);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(source);
        expect(result.stderr).toContain(field);
        const { access } = await import("node:fs/promises");
        await expect(access(path.join(root, "executed"))).rejects.toThrow();
      },
    );

    it.for([
      {
        name: "local committed schema",
        binding: { ...committed, accepts: "./valid.json" },
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
      },
      {
        name: "normal turn select",
        binding: {
          from: { runtime: runtimeId },
          select: "/value",
          accepts: "./valid.json",
        },
      },
    ])(
      "accepts $name without executing code",
      async ({ binding }, { signal }) => {
        const { root } = await fixture(layout, binding, { "valid.json": "{}" });
        const result = await cli(root, signal);
        expect(result.status, result.stderr).toBe(0);
        let stderr = "";
        expect(
          await runValidateManifest([root], {
            stdout: { write: () => {} },
            stderr: { write: (text) => (stderr += text) },
          }),
          stderr,
        ).toBe(0);
        const { access } = await import("node:fs/promises");
        await expect(access(path.join(root, "executed"))).rejects.toThrow();
      },
    );

    it("parser rejects committed select and retains normal turn select", () => {
      const runtime = (binding: object) => ({
        type: "agent",
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
