import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";
const script = path.resolve(
  import.meta.dirname,
  "../scripts/validate-manifest.ts",
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(fields: Record<string, unknown> = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "covel-authoring-"));
  roots.push(temp);
  const root = path.join(temp, "probe");
  await write(root, "PLUGIN.md", {
    id: "probe",
    kind: "plugin",
    description: "Probe",
    ...fields,
  });
  return root;
}
async function write(root: string, filename: string, value: unknown) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "handler.js"),
    "export default () => ({ outcome: 'success' });",
  );
  await writeFile(
    path.join(root, filename),
    `---\n${JSON.stringify(value)}\n---\n`,
    "utf8",
  );
}
// Runs the validation in this process. A `tsx` child for each check loads the
// loader and its schemas again, and how long that takes depends on the
// machine's load.
async function validate(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const status = await runValidateManifest(args, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { status, stdout, stderr };
}
const runtime = {
  function: { handler: "./handler.js", timeoutMs: 90_000 },
  schedule: { trigger: { type: "manual" } },
};
describe("manifest authoring CLI", () => {
  it("ignores runtime symlinks in both discovery and locale validation", async () => {
    const root = await fixture();
    const target = path.join(root, "lib/linked");
    await mkdir(target, { recursive: true });
    await mkdir(path.join(root, "runtimes"));
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const probe = "__covelValidateFrontmatterProbe";
    await writeFile(
      path.join(target, "RUNTIME.md"),
      `---js\n(() => { globalThis.${probe} = true; return {}; })()\n---\n`,
    );
    await symlink(target, path.join(root, "runtimes/linked"));
    try {
      expect(await validate(root)).toMatchObject({ status: 0, stderr: "" });
      expect(globals[probe]).toBeUndefined();
    } finally {
      delete globals[probe];
    }
  });

  it.each([undefined, "runtime.md", "RUNTIME.zh.md", "helper.js"])(
    "explains a missing runtime manifest beside %s",
    async (filename) => {
      const root = await fixture();
      const child = path.join(root, "runtimes/missing");
      await mkdir(child, { recursive: true });
      if (filename) await writeFile(path.join(child, filename), "");
      const result = await validate(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${child}/RUNTIME.md`);
      expect(result.stderr).toContain("shared code in lib/");
    },
  );

  it.each([
    { schedule: { ...runtime.schedule, needs: ["extract"] } },
    { schedule: { ...runtime.schedule, after: [{ runtime: "extract" }] } },
    { io: { inputs: { facts: { from: { runtime: "extract" } } } } },
  ])(
    "suggests the complete local runtime ID for an unprefixed reference: %j",
    async (reference) => {
      const root = await fixture();
      await write(path.join(root, "runtimes/extract"), "RUNTIME.md", runtime);
      await write(path.join(root, "runtimes/read"), "RUNTIME.md", {
        ...runtime,
        ...reference,
      });
      const result = await validate(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("probe/extract");
      expect(result.stderr).not.toContain("outside package");
      expect(result.stderr).not.toContain("use a contract");
    },
  );
  it.each([
    { runtime: { ...runtime, function: { handler: "./missing.js" } } },
    { runtime: { function: { handler: "./handler.js" } } },
    {
      runtime: {
        ...runtime,
        function: {
          handler: "./handler.js",
          tools: { builtin: ["unknown-tool"] },
        },
      },
    },
    { contributes: { ui: { right: ["./missing.json"] } } },
    {
      runtime: {
        ...runtime,
        io: { output: { schema: "./missing.schema.json" } },
      },
    },
  ])(
    "rejects unusable static declarations before loading code: %j",
    async (fields) => {
      const result = await validate(await fixture(fields));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN.md");
      expect(result.stderr).toMatch(
        /handler|schedule.stage|ui.right|output.schema|tools.builtin/,
      );
    },
  );

  async function uiFixture(view: unknown) {
    const root = await fixture({
      contributes: { ui: { right: ["./ui/panel.json"] } },
    });
    await mkdir(path.join(root, "ui"), { recursive: true });
    await writeFile(
      path.join(root, "ui/panel.json"),
      JSON.stringify({ id: "panel", label: "Panel", view }),
    );
    return root;
  }
  const list = (repeat: unknown, text: unknown) => ({
    component: "Stack",
    children: [
      {
        component: "Stack",
        repeat,
        children: [{ component: "Text", props: { text } }],
      },
    ],
  });

  it("accepts a UI spec of known components with both repeat forms", async () => {
    const result = await validate(
      await uiFixture({
        component: "Stack",
        repeat: { statePath: "/entries", key: "key" },
        children: [
          {
            component: "Card",
            slots: {
              content: [
                {
                  type: "Stack",
                  repeat: { statePath: { $item: "tags" } },
                  children: [
                    { component: "Text", props: { text: { $item: "" } } },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    [
      "an unknown template component",
      {
        component: "FilterContainer",
        props: {
          items: { $state: "/entries" },
          itemTemplate: { component: "Kard" },
        },
      },
      "view.props.itemTemplate.component: unknown component Kard",
    ],
    [
      "invalid map labels",
      {
        component: "Badge",
        props: { label: { $map: "active", labels: ["Active"] } },
      },
      "view.props.label.labels:",
    ],
    [
      "an unknown component",
      { component: "Stack", children: [{ component: "Kard" }] },
      "view.children[0].component: unknown component Kard; use a component name from docs/reference/ui-components.md",
    ],
    [
      "a $state repeat path",
      list({ statePath: { $state: "/entries" } }, "x"),
      'view.children[0].repeat.statePath: must be an absolute state path string such as "/entries", or { "$item": "field" } inside another repeat',
    ],
    [
      "a repeat path that is not absolute",
      list({ statePath: "entries" }, "x"),
      "view.children[0].repeat.statePath: must be an absolute state path string",
    ],
    [
      "an $item field with a leading slash",
      list({ statePath: "/entries" }, { $item: "/key" }),
      'view.children[0].children[0].props.text.$item: "/key" must not start with a slash; write the item\'s field name ("key")',
    ],
  ])("rejects a UI spec with %s", async (_name, view, message) => {
    const result = await validate(await uiFixture(view));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `PLUGIN.md: contributes.ui.right: ./ui/panel.json: ${message}`,
    );
  });

  it("rejects a UI spec that declares neither view nor webview", async () => {
    const result = await validate(await uiFixture(undefined));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "./ui/panel.json: view: a UI spec declares either view or webview",
    );
  });

  it.each([
    "name",
    "stage",
    "capabilities",
    "authorsNote",
    "postHistory",
    "userSettings",
  ])("rejects legacy root field %s", async (field) => {
    const result = await validate(await fixture({ [field]: "legacy" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(field);
  });
  it("accepts label translations and entry-only contribution packages", async () => {
    const root = await fixture({
      entry: "./server/index.js",
      contributes: {
        ui: { right: ["./ui/panel.json"] },
        prompt: [{ id: "guide", content: "Guidance", position: { depth: 2 } }],
      },
    });
    await mkdir(path.join(root, "server"), { recursive: true });
    await mkdir(path.join(root, "ui"), { recursive: true });
    await writeFile(
      path.join(root, "server/index.js"),
      "export default () => {};",
    );
    await writeFile(
      path.join(root, "ui/panel.json"),
      JSON.stringify({ view: { component: "Stack" } }),
    );
    await mkdir(path.join(root, "locales"));
    await writeFile(
      path.join(root, "locales/zh.yaml"),
      "PLUGIN.md:\n  description: 探针\n",
    );
    const result = await validate(root);
    expect(result.status, result.stderr).toBe(0);
  });
  it("rejects a label written as a locale map and a translation it cannot place", async () => {
    const inline = await validate(
      await fixture({ description: { en: "Probe", zh: "探针" } }),
    );
    expect(inline.status).toBe(1);
    expect(inline.stderr).toContain("written as a locale map (description)");

    const root = await fixture();
    await mkdir(path.join(root, "locales"));
    await writeFile(
      path.join(root, "locales/zh.yaml"),
      "PLUGIN.md:\n  kind: 插件\n",
    );
    const stray = await validate(root);
    expect(stray.status).toBe(1);
    expect(stray.stderr).toContain("kind is not a label");
  });
  it.each(["directory", "root", "child"])(
    "validates all runtime declarations through a %s path",
    async (kind) => {
      const root = await fixture();
      await write(path.join(root, "runtimes/note"), "RUNTIME.md", runtime);
      await write(path.join(root, "runtimes/listener"), "RUNTIME.md", {
        ...runtime,
        schedule: { trigger: { type: "event", topic: "note.created" } },
      });
      const target =
        kind === "directory"
          ? root
          : kind === "root"
            ? path.join(root, "PLUGIN.md")
            : path.join(root, "runtimes/note/RUNTIME.md");
      const result = await validate(target);
      expect(result.status, result.stderr).toBe(0);
    },
  );
  it("warns that a plugin's own llm.toml is not read", async () => {
    const root = await fixture({ runtime });
    await writeFile(
      path.join(root, "llm.toml"),
      '[plugin.default]\nprovider = "acme"\nmodel = "m"\nbaseUrl = "https://acme.example/v1"\n',
    );
    const result = await validate(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("warning: llm.toml is ignored");
    await rm(path.join(root, "llm.toml"));
    expect((await validate(root)).stdout).not.toContain("llm.toml");
  });

  it("rejects root execution alongside a runtimes directory", async () => {
    const root = await fixture({ runtime });
    await write(path.join(root, "runtimes/note"), "RUNTIME.md", runtime);
    const result = await validate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtime");
  });
  it("rejects package contributions on a child even if equal to the root", async () => {
    const root = await fixture({ contributes: { settings: [] } });
    await write(path.join(root, "runtimes/note"), "RUNTIME.md", {
      ...runtime,
      contributes: { settings: [] },
    });
    const result = await validate(path.join(root, "runtimes/note/RUNTIME.md"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contributes");
  });
  it("rejects legacy child PLUGIN.md files", async () => {
    const root = await fixture();
    await write(path.join(root, "runtimes/note"), "PLUGIN.md", runtime);
    const result = await validate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RUNTIME.md");
  });
  it("validates sibling declarations when passed a child path", async () => {
    const root = await fixture();
    await write(path.join(root, "runtimes/note"), "RUNTIME.md", runtime);
    await write(path.join(root, "runtimes/bad"), "RUNTIME.md", {
      ...runtime,
      type: "unknown",
    });
    const result = await validate(path.join(root, "runtimes/note/RUNTIME.md"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtimes/bad/RUNTIME.md");
  });
  it("validates each package once for overlapping paths", async () => {
    const root = await fixture();
    await write(path.join(root, "runtimes/note"), "RUNTIME.md", runtime);
    const result = await validate(
      root,
      path.join(root, "PLUGIN.md"),
      path.join(root, "runtimes/note/RUNTIME.md"),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/✓/g)).toHaveLength(1);
  });
  it("reports missing paths and unsupported flags", async () => {
    expect((await validate("/missing/covel/plugin")).status).toBe(1);
    expect((await validate("--legacy")).status).toBe(2);
  });
  // `pnpm check` runs the script file and reads its exit status, so one check
  // starts it as a process. The child has no time limit of its own: the
  // test's limit is the only one, and `signal` stops the child at that limit.
  it("exits with the validation status when run as a script", async ({
    signal,
  }) => {
    const root = await fixture({ name: "legacy" });
    const result = await new Promise<{ status: number; stderr: string }>(
      (resolve, reject) => {
        execFile(
          process.execPath,
          ["--import", "tsx", script, root],
          { signal },
          (error, _stdout, stderr) => {
            if (!error) resolve({ status: 0, stderr });
            else if (typeof error.code === "number")
              resolve({ status: error.code, stderr });
            else reject(error);
          },
        );
      },
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("✗");
  });
});

describe("package.json of a plugin", () => {
  // Without `"type": "module"` Node reads the package's `.js` files as
  // CommonJS: an `import` in them fails and the development reload misses them.
  it.each([
    { packageJson: { name: "probe" }, found: "no type" },
    { packageJson: { name: "probe", type: "commonjs" }, found: '"commonjs"' },
  ])("is refused when it declares $found", async ({ packageJson, found }) => {
    const root = await fixture({ runtime });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(packageJson),
    );
    const result = await validate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `package.json must declare "type": "module" (found ${found})`,
    );
  });

  it("is accepted when it declares the ESM type", async () => {
    const root = await fixture({ runtime });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "probe", type: "module" }),
    );
    const result = await validate(root);
    expect(result.status, result.stderr).toBe(0);
  });
});
