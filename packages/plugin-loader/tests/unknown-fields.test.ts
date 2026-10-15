/**
 * A whole field this host does not know is left out at load with a warning,
 * so the package keeps working; `pnpm validate:plugin` still reports it as an
 * error. An unknown key inside a declaration the host reads, or a field that
 * looks like a guarded one, still rejects the manifest.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";
import {
  compileInlineRuntime,
  discoverPluginAt,
  loadPluginDefinition,
  parsePluginMd,
  parseRuntimeMd,
} from "../src/index.js";

const md = (value: object) => `---\n${JSON.stringify(value)}\n---\nPrompt.\n`;
const root = { id: "probe", kind: "plugin", description: "Probe" };
const staged = {
  type: "function",
  function: { handler: "../../handler.js" },
  schedule: { stage: "narrative" },
};
const plugin = parsePluginMd(md(root), "probe/PLUGIN.md").plugin;
const runtimeMd = (value: object) =>
  parseRuntimeMd(md(value), "probe/runtimes/run/RUNTIME.md", plugin);

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(
  fields: Record<string, unknown>,
  runtimes: Record<string, unknown> = {},
) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "covel-unknown-"));
  roots.push(temp);
  const dir = path.join(temp, "probe");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "PLUGIN.md"), md({ ...root, ...fields }));
  await writeFile(
    path.join(dir, "handler.js"),
    "export default () => ({ outcome: 'success' });",
  );
  for (const [id, runtime] of Object.entries(runtimes)) {
    await mkdir(path.join(dir, "runtimes", id), { recursive: true });
    await writeFile(
      path.join(dir, "runtimes", id, "RUNTIME.md"),
      md(runtime as object),
    );
  }
  return dir;
}

async function validate(dir: string) {
  let stderr = "";
  const status = await runValidateManifest([dir], {
    stdout: { write: () => true },
    stderr: { write: (text) => (stderr += text) },
  });
  return { status, stderr };
}

describe("unknown manifest fields", () => {
  it.each([
    [{ sandbox: true }, "sandbox"],
    [{ contributes: { widgets: ["x"] } }, "contributes.widgets"],
    [
      {
        runtime: {
          type: "agent",
          schedule: { stage: "narrative" },
          priority: 3,
        },
      },
      "runtime.priority",
    ],
  ])("PLUGIN.md loads without %j", (fields, field) => {
    const parsed = parsePluginMd(md({ ...root, ...fields }), "probe/PLUGIN.md");
    expect(parsed.ignoredFields).toEqual([
      {
        sourcePath: "probe/PLUGIN.md",
        field,
        message: `probe/PLUGIN.md: ${field}: unknown field`,
      },
    ]);
    // The original frontmatter stays as written; only the parsed form drops it.
    expect(JSON.stringify(parsed.plugin)).not.toContain(
      field.split(".").at(-1),
    );
    if ("runtime" in fields)
      expect(compileInlineRuntime(parsed)?.manifest.stage).toBe("narrative");
  });

  it("RUNTIME.md loads without an unknown field, even one named like a short guarded field", () => {
    const parsed = runtimeMd({ ...staged, priority: 3, ui: "right" });
    expect(parsed.ignoredFields?.map((ignored) => ignored.field)).toEqual([
      "priority",
      "ui",
    ]);
    expect(parsed.manifest.stage).toBe("narrative");
  });

  it.each([
    [{ permissions: { http: [], fs: true } }, '"fs" inside a declaration'],
    [
      {
        contributes: {
          settings: [
            { key: "limit", type: "number", label: "L", default: 3, hide: 1 },
          ],
        },
      },
      '"hide" inside a declaration',
    ],
    [
      { runtime: { ...staged, io: { visibility: "system", conceal: true } } },
      '"conceal" inside a declaration',
    ],
  ])(
    "PLUGIN.md still rejects an unknown key inside a known field %j",
    (fields, message) => {
      expect(() =>
        parsePluginMd(md({ ...root, ...fields }), "probe/PLUGIN.md"),
      ).toThrow(message);
    },
  );

  it("RUNTIME.md still rejects an unknown key inside a known field", () => {
    expect(() =>
      runtimeMd({ ...staged, schedule: { stage: "narrative", priority: 1 } }),
    ).toThrow('"priority" inside a declaration this host reads');
  });

  it.each([
    ["permision", "permissions"],
    ["Permissions", "permissions"],
    ["covle", "covel"],
    ["requries", "requires"],
    ["conflict", "conflicts"],
    ["ID", "id"],
    ["runtimes", "runtime"],
  ])("PLUGIN.md rejects %s, which looks like %s", (key, meant) => {
    expect(() =>
      parsePluginMd(md({ ...root, [key]: [] }), "probe/PLUGIN.md"),
    ).toThrow(`unknown field "${key}" looks like "${meant}"`);
  });

  it.each([
    ["gaurd", "guard"],
    ["permission", "permissions"],
    ["efects", "effects"],
    ["typ", "type"],
    ["schedul", "schedule"],
  ])("RUNTIME.md rejects %s, which looks like %s", (key, meant) => {
    expect(() => runtimeMd({ ...staged, [key]: {} })).toThrow(
      `unknown field "${key}" looks like "${meant}"`,
    );
  });

  it("loading warns and keeps the package; validate:plugin reports each field", async () => {
    const dir = await fixture(
      { sandbox: true, contributes: { widgets: [] } },
      { run: { ...staged, priority: 3 } },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const definition = await loadPluginDefinition(
      (await discoverPluginAt(dir))!,
    );
    expect(
      definition.manifests.map((runtime) => runtime.manifest.name),
    ).toEqual(["probe/run"]);
    expect(
      definition.ignoredFields.map((ignored) => ignored.field).sort(),
    ).toEqual(["contributes.widgets", "priority", "sandbox"]);
    const warnings = warn.mock.calls.map(([line]) => String(line));
    for (const field of ["sandbox", "contributes.widgets", "priority"])
      expect(warnings).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `${field.replace(".", "\\.")}: unknown field; this host does not know it and loads the package without it$`,
          ),
        ),
      );

    const result = await validate(dir);
    expect(result.status).toBe(1);
    for (const line of [
      "PLUGIN.md: sandbox: unknown field",
      "PLUGIN.md: contributes.widgets: unknown field",
      "RUNTIME.md: priority: unknown field",
    ])
      expect(result.stderr).toContain(line);
  });

  it("ignores unsupported UI placements at load and reports them during validation", async () => {
    const dir = await fixture({
      contributes: {
        ui: { left: ["./missing.json"], future: ["./future.json"] },
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const definition = await loadPluginDefinition(
      (await discoverPluginAt(dir))!,
    );
    expect(definition.packageManifest.manifest.ui).toEqual({});
    expect(definition.ignoredFields.map((field) => field.field)).toEqual([
      "contributes.ui.left",
      "contributes.ui.future",
    ]);
    const result = await validate(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contributes.ui.left: unknown field");
    expect(result.stderr).not.toContain("cannot read");
  });

  it("a guarded misspelling fails the load and validation alike", async () => {
    const dir = await fixture({ permision: { http: [] } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      loadPluginDefinition((await discoverPluginAt(dir))!),
    ).rejects.toThrow('looks like "permissions"');
    const result = await validate(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('looks like "permissions"');
  });
});
