import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";
import {
  validatePluginPackage,
  parseIssueLocation,
  redactPaths,
} from "../src/package-validation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const runtime = {
  function: { handler: "./handler.js", timeoutMs: 90_000 },
  schedule: { trigger: { type: "manual" } },
};
const md = (fields: Record<string, unknown>) =>
  `---\n${JSON.stringify(fields)}\n---\n`;
async function fixture(
  fields: Record<string, unknown> = {},
  files: Record<string, string> = {},
) {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "covel-package-validation-"),
  );
  roots.push(temp);
  const root = path.join(temp, "probe");
  for (const [file, content] of Object.entries({
    "PLUGIN.md": md({
      id: "probe",
      kind: "plugin",
      description: "Probe",
      ...fields,
    }),
    "handler.js": "throw new Error('must never run')",
    ...files,
  })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}
async function parity(root: string) {
  const report = await validatePluginPackage(root);
  let stdout = "",
    stderr = "";
  const status = await runValidateManifest([root], {
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  expect(status).toBe(report.ok ? 0 : 1);
  expect(stderr).toBe(report.ok ? "" : `✗ ${report.cliFailure}\n`);
  expect(stdout).toBe(
    report.ok
      ? `✓ Static package validation: ${report.rootPath}\n  languages: ${report.languages}\n${report.cliWarnings.map((line) => `${line}\n`).join("")}`
      : "",
  );
  return report;
}

describe("static package validation", () => {
  const unusable = [
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
  ];
  it.each([
    {},
    { runtime },
    ...unusable,
    ...[
      "name",
      "stage",
      "capabilities",
      "authorsNote",
      "postHistory",
      "userSettings",
    ].map((field) => ({ [field]: "legacy" })),
  ])(
    "retains CLI status and exact text for root declarations %#",
    async (fields) => {
      await parity(await fixture(fields));
    },
  );
  it.each([undefined, "runtime.md", "RUNTIME.zh.md", "helper.js", "PLUGIN.md"])(
    "retains layout failures beside %s",
    async (filename) => {
      const root = await fixture();
      const child = path.join(root, "runtimes/missing");
      await mkdir(child, { recursive: true });
      if (filename) await writeFile(path.join(child, filename), "");
      expect((await parity(root)).ok).toBe(false);
    },
  );
  it.each([
    { schedule: { ...runtime.schedule, needs: ["extract"] } },
    { schedule: { ...runtime.schedule, after: [{ runtime: "extract" }] } },
    { io: { inputs: { facts: { from: { runtime: "extract" } } } } },
    { contributes: { settings: [] } },
    { type: "unknown" },
    {},
  ])("retains multi-runtime failures and success %#", async (reference) => {
    await parity(
      await fixture(
        {},
        {
          "runtimes/extract/RUNTIME.md": md(runtime),
          "runtimes/read/RUNTIME.md": md({ ...runtime, ...reference }),
          "runtimes/extract/handler.js": "",
          "runtimes/read/handler.js": "",
        },
      ),
    );
  });
  it.each([{}, { type: "commonjs" }, { type: "module" }])(
    "retains module-type parity %#",
    async (pkg) => {
      await parity(
        await fixture({ runtime }, { "package.json": JSON.stringify(pkg) }),
      );
    },
  );
  it.each(["root", "child"])("normalises %s manifest paths", async (kind) => {
    const root = await fixture(
      {},
      {
        "runtimes/note/RUNTIME.md": md(runtime),
        "runtimes/note/handler.js": "",
      },
    );
    const report = await parity(
      path.join(
        root,
        kind === "root" ? "PLUGIN.md" : "runtimes/note/RUNTIME.md",
      ),
    );
    expect(report.rootPath).toBe(root);
  });
  it.each([
    {
      component: "Stack",
      repeat: { statePath: "/entries", key: "key" },
      children: [
        {
          type: "Stack",
          repeat: { statePath: { $item: "tags" } },
          children: [{ component: "Text", props: { text: { $item: "" } } }],
        },
      ],
    },
    {
      component: "FilterContainer",
      props: {
        items: { $state: "/entries" },
        itemTemplate: { component: "Kard" },
      },
    },
    {
      component: "Badge",
      props: { label: { $map: "active", labels: ["Active"] } },
    },
    { component: "Stack", children: [{ component: "Kard" }] },
    {
      component: "Stack",
      children: [
        { component: "Stack", repeat: { statePath: { $state: "/entries" } } },
      ],
    },
    { component: "Stack", repeat: { statePath: "entries" } },
    {
      component: "Stack",
      repeat: { statePath: "/entries" },
      children: [{ component: "Text", props: { text: { $item: "/key" } } }],
    },
    undefined,
  ])("retains CLI parity for UI specs %#", async (view) => {
    await parity(
      await fixture(
        { contributes: { ui: { right: ["./ui/panel.json"] } } },
        { "ui/panel.json": JSON.stringify({ view }) },
      ),
    );
  });
  const labelFixtures: {
    fields: Record<string, unknown>;
    files: Record<string, string>;
  }[] = [
    { fields: { description: { en: "Probe", zh: "探针" } }, files: {} },
    { fields: {}, files: { "locales/zh.yaml": "PLUGIN.md:\n  kind: 插件\n" } },
    {
      fields: {
        entry: "./server/index.js",
        contributes: {
          prompt: [
            { id: "guide", content: "Guidance", position: { depth: 2 } },
          ],
        },
      },
      files: {
        "server/index.js": "throw new Error('never import')",
        "locales/zh.yaml": "PLUGIN.md:\n  description: 探针\n",
      },
    },
  ];
  it.each(labelFixtures)(
    "retains CLI parity for translated labels %#",
    async ({ fields, files }) => {
      await parity(await fixture(fields, files));
    },
  );
  it("preserves inline/multi-runtime layout conflict text", async () => {
    expect(
      (
        await parity(
          await fixture(
            { runtime },
            {
              "runtimes/note/RUNTIME.md": md(runtime),
              "runtimes/note/handler.js": "",
            },
          ),
        )
      ).ok,
    ).toBe(false);
  });
  it("prints repeated normalisation errors and deduplicates resolved packages", async () => {
    let stderr = "";
    expect(
      await runValidateManifest(
        ["/missing/covel/plugin", "/missing/covel/plugin"],
        {
          stdout: { write: () => {} },
          stderr: { write: (text) => (stderr += text) },
        },
      ),
    ).toBe(1);
    expect(stderr.match(/✗/g)).toHaveLength(2);
    const root = await fixture();
    let stdout = "";
    await runValidateManifest([root, path.join(root, "PLUGIN.md")], {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: () => {} },
    });
    expect(stdout.match(/✓/g)).toHaveLength(1);
  });
  it("reports valid package languages and warnings without failing", async () => {
    const result = await parity(await fixture({}, { "llm.toml": "" }));
    expect(result.ok).toBe(true);
    expect(result.languages).toContain("en");
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["authoring-warning", "llm-toml-ignored"]),
    );
  });
  it("collects independent unknown fields, bad labels, missing handlers and module type", async () => {
    const result = await parity(
      await fixture(
        {
          futureFeature: true,
          runtime: { ...runtime, function: { handler: "./missing.js" } },
        },
        {
          "package.json": '{"type":"commonjs"}',
          "locales/zh.yaml": "PLUGIN.md:\n  kind: 插件\n",
        },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "unknown-field",
        file: "PLUGIN.md",
        field: "futureFeature",
        hint: expect.stringContaining("remove it"),
      }),
    );
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "plugin-files",
        "locale-files",
        "package-module-type",
      ]),
    );
    expect(
      result.issues.find((issue) => issue.code === "plugin-files")?.file,
    ).toBe("PLUGIN.md");
  });
  it("never executes entry modules", async () => {
    const root = await fixture({ entry: "./server/index.js" });
    const sentinel = path.join(root, "executed");
    await mkdir(path.join(root, "server"));
    await writeFile(
      path.join(root, "server/index.js"),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'yes'); throw new Error('imported');`,
    );
    expect((await parity(root)).ok).toBe(true);
    await expect(access(sentinel)).rejects.toThrow();
  });
  it("names a removed builtin as an unknown tool", async () => {
    const result = await parity(
      await fixture({
        runtime: {
          schedule: { stage: "narrative" },
          agent: { tools: { builtin: ["plugin-data-set"] } },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.cliFailure).toContain(
      "unknown tool plugin-data-set; use a documented framework tool name",
    );
  });
  it("reports not-found without throwing", async () =>
    expect((await parity("/missing/covel/plugin")).ok).toBe(false));
});

describe("diagnostic locations and redaction", () => {
  it("parses nested locations and Windows drive letters", () => {
    expect(
      parseIssueLocation(
        "C:\\Users\\Me\\probe\\PLUGIN.md: contributes.ui.right: ./panel.json: view.children[0].component: unknown",
        "c:\\users\\me\\probe",
      ),
    ).toEqual({
      file: "panel.json",
      field: "view.children[0].component",
      message: "unknown",
    });
    expect(parseIssueLocation("Just a message", "/package")).toEqual({
      message: "Just a message",
    });
    expect(parseIssueLocation("Error: unrelated text", "/package")).toEqual({
      message: "Error: unrelated text",
    });
  });
  it("redacts every public string including foreign paths and UNC shares", () => {
    const root = path.join(os.tmpdir(), "secret-package");
    const home = os.homedir();
    const report = {
      file: `${root}/PLUGIN.md`,
      field: `${root}/some-field`,
      message: `${root}: ${os.tmpdir()}/secret-other/file ${home}/secrets/key /opt/private/host/nested/file C:\\outside\\private\\host\\file \\\\server\\share\\secret\\file`,
      hint: `${home}/private/secret`,
    };
    const redacted = JSON.stringify(
      Object.fromEntries(
        Object.entries(report).map(([key, value]) => [
          key,
          redactPaths(value, { root, extra: [os.tmpdir(), home] }),
        ]),
      ),
    );
    for (const prefix of [
      root,
      home,
      os.tmpdir(),
      "/opt/private",
      "C:/outside",
      "//server",
    ])
      expect(redacted).not.toContain(prefix);
    expect(redactPaths(`${root}-other/file`, { root })).not.toBe("-other/file");
    expect(
      redactPaths(
        "../../host/private/file C:\\host\\key \\\\host\\share\\key",
        { root },
      ),
    ).toBe("<path> <path> <path>");
  });
});

it("validates multi-file pages with the same planner the loader uses", async () => {
  const root = await fixture(
    { contributes: { ui: { view: ["./ui/view.json"] } } },
    {
      "ui/view.json": JSON.stringify({
        id: "page",
        label: "Page",
        webview: { root: "./ui/app", entry: "index.html" },
      }),
      "ui/app/index.html": "<head></head>",
      "ui/app/app.js": "// page",
    },
  );
  const {
    loadPluginUiSpecs,
    loadPluginDefinition,
    discoverPluginAt,
    validatePluginFiles,
  } = await import("../src/index.js");
  expect((await validatePluginPackage(root)).ok).toBe(true);
  const discovery = await discoverPluginAt(root);
  if (!discovery) throw new Error("missing discovery");
  const definition = await loadPluginDefinition(discovery);
  expect(() =>
    validatePluginFiles(
      definition.packageManifest,
      definition.manifests,
      (file) => {
        // This callback is only asked for JSON; the root requires an explicit listing.
        if (file.endsWith("view.json"))
          return JSON.stringify({
            id: "page",
            label: "Page",
            webview: { root: "./ui/app", entry: "index.html" },
          });
        throw new Error("unexpected read");
      },
    ),
  ).toThrow("cannot list webview.root");
  expect(
    (await loadPluginUiSpecs(root, "probe", { view: ["ui/view.json"] }))
      .diagnostics,
  ).toEqual([]);
  await mkdir(path.join(root, "ui/app/__covel__"));
  const report = await validatePluginPackage(root);
  expect(report.ok).toBe(false);
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      code: "plugin-files",
      file: "ui/view.json",
      field: "webview.root",
      message: expect.stringContaining("reserved"),
    }),
  );
});
