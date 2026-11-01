import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  assessPluginExecution,
  discoverPluginAt,
  loadPluginDefinition,
  loadPluginUiSpecs,
  parsePluginMd,
  readPackageInventory,
  validatePluginPackage,
} from "../src/index.js";

const md = (value: object) => `---\n${JSON.stringify(value)}\n---\nKeep notes.`;
const base = {
  description: "Public notes",
  runtime: { schedule: { stage: "pre-turn" } },
};
function assess(extra: object = {}, files: Record<string, string> = {}) {
  const content = md({ ...base, ...extra });
  return assessPluginExecution({
    files: Object.entries({ "PLUGIN.md": content, ...files }).map(
      ([relativePath, text]) => ({ relativePath, content: Buffer.from(text) }),
    ),
    root: parsePluginMd(content, "/probe/PLUGIN.md"),
    runtimes: [],
  });
}
const view = { contributes: { ui: { view: ["./ui/page.json"] } } };
const browser = {
  "ui/page.json": JSON.stringify({
    id: "page",
    label: "Page",
    webview: { root: "./ui/page", entry: "index.html" },
    bridge: "session",
  }),
  "ui/page/index.html": '<script src="app.js"></script>',
  "ui/page/app.js": 'document.body.dataset.ready = "yes";',
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "declarative-"));
  roots.push(root);
  return root;
}

it.each([
  [{}, {}],
  [{ runtime: undefined }, {}],
  [
    { runtime: undefined },
    {
      "runtimes/a/RUNTIME.md": md({ schedule: { stage: "pre-turn" } }),
      "runtimes/b/RUNTIME.md": md({
        schedule: { trigger: { type: "manual" } },
      }),
    },
  ],
  [
    {
      runtime: {
        agent: {
          tools: {
            builtin: ["sync-characters"],
            services: [
              { contract: "notes.read@1", as: "read-note" },
              { contract: "notes.write@1", as: "write-note" },
            ],
          },
        },
      },
    },
    {},
  ],
  [view, browser],
  [
    { contributes: { ui: { view: ["./page.json"] } } },
    {
      "page.json": JSON.stringify({
        id: "page",
        label: "Page",
        webview: { entry: "./page.html" },
      }),
      "page.html": "<script>document.body.textContent = 'ready'</script>",
    },
  ],
])(
  "recognizes data and agent declarations without executing them (%#)",
  (extra, files) => {
    expect(assess(extra, files)).toEqual({
      mode: "declarative",
      diagnostics: [],
    });
  },
);
it.each<[string, object]>([
  ["entry", { entry: "./missing.js" }],
  ["runtime.function", { runtime: { function: {} } }],
  [
    "runtime.function",
    { runtime: { enabled: false, function: { handler: "./other.js" } } },
  ],
  ["runtime.guard", { runtime: { guard: "./guard.js" } }],
  [
    "permissions.http",
    { permissions: { http: [{ origin: "https://example.test" }] } },
  ],
  [
    "runtime.permissions.http",
    {
      runtime: { permissions: { http: [{ origin: "https://example.test" }] } },
    },
  ],
  ...["tools", "wires", "actions", "forms"].map((field): [string, object] => [
    `contributes.${field}`,
    { contributes: { [field]: ["provided"] } },
  ]),
  ["contributes.hooks", { contributes: { hooks: ["PreToolUse"] } }],
  ["contributes.services", { contributes: { services: ["probe@1"] } }],
  [
    "contributes.extensions",
    { contributes: { extensions: ["prompt.segment@1/probe"] } },
  ],
])(
  "retains executable declaration evidence at %s even if validation drops it",
  (field, extra) => {
    const result = assess(extra as object);
    expect(result.mode).toBe("code");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ file: "PLUGIN.md", field }),
    );
  },
);
it.each([
  "js",
  "mjs",
  "cjs",
  "ts",
  "mts",
  "cts",
  "tsx",
  "jsx",
  "node",
  "wasm",
  "JS",
])("never exempts unlisted .%s files", (extension) => {
  const result = assess(view, {
    ...browser,
    [`ui/page/extra.${extension}`]: "code",
    "unused.js": "code",
  });
  expect(result.mode).toBe("code");
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ file: "unused.js" }),
  );
  if (extension.toLowerCase() !== "js")
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ file: `ui/page/extra.${extension}` }),
    );
});
it.each([
  { entry: "./ui/page/app.js" },
  { runtime: { guard: "./ui/page/app.js" } },
])(
  "server references take precedence over browser asset membership (%#)",
  (extra) => {
    expect(assess({ ...view, ...extra }, browser).mode).toBe("code");
  },
);
it.each<Record<string, string>>([
  { "ui/page.json": "not JSON" },
  {
    "ui/page.json": JSON.stringify({
      id: "page",
      label: "Page",
      webview: { root: "../page", entry: "index.html" },
    }),
  },
  { "ui/page/.ignored.js": "code" },
  { "ui/page/node_modules/ignored.js": "code" },
  { "ui/page/__covel__/reserved.txt": "reserved" },
  { "ui/page/large.txt": "x".repeat(8 * 1024 * 1024 + 1) },
])(
  "a broken or unlisted browser feature grants no executable exception (%#)",
  (extra) => {
    expect(assess(view, { ...browser, ...extra }).mode).toBe("code");
  },
);
it("retains disabled and localized function evidence", () => {
  const result = assess(
    {},
    {
      "runtimes/off/RUNTIME.md": md({ enabled: false, function: {} }),
      "PLUGIN.zh.md": md({ runtime: { guard: "./guard.js" } }),
    },
  );
  expect(result.mode).toBe("code");
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      file: "runtimes/off/RUNTIME.md",
      field: "function",
    }),
  );
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ file: "PLUGIN.zh.md", field: "runtime.guard" }),
  );
});
it.each(["../outside.js", "dir\\code.js", "/absolute.js"])(
  "fails closed for incomplete inventory %s",
  (name) => {
    expect(assess({}, { [name]: "code" }).mode).toBe("unknown");
  },
);
it("does not turn malformed manifest inspection into a positive proof", () => {
  expect(
    assess(
      {},
      {
        "runtimes/off/RUNTIME.md":
          "---\n!<tag:yaml.org,2002:js/function> function(){}\n---",
      },
    ).mode,
  ).toBe("unknown");
});
it("loads the clean distribution with the same assessment as an archive inventory", async () => {
  const root = path.join(await temp(), "declarative-notebook");
  await cp(
    path.resolve(
      import.meta.dirname,
      "../../../tests/third-party/declarative-notebook",
    ),
    root,
    { recursive: true },
  );
  const discovery = await discoverPluginAt(root);
  expect(discovery).toBeDefined();
  const definition = await loadPluginDefinition(discovery!);
  expect(definition.disabledRuntimes).toEqual([]);
  expect(definition.executionAssessment).toMatchObject({
    mode: "declarative",
    diagnostics: [],
    signature: expect.any(String),
    digest: expect.any(String),
  });
  const inventory = await readPackageInventory(root);
  expect(
    assessPluginExecution({
      ...inventory,
      root: definition.packageManifest,
      runtimes: definition.manifests,
    }),
  ).toEqual({ mode: "declarative", diagnostics: [] });
  const report = await validatePluginPackage(root);
  expect(report.ok, JSON.stringify(report.issues)).toBe(true);
  expect(definition.packageManifest.manifest.datasets?.notes).toMatchObject({
    key: "id",
    namespace: "notes",
  });
  const ui = await loadPluginUiSpecs(
    root,
    definition.packageManifest.plugin.id,
    definition.packageManifest.plugin.contributes?.ui,
  );
  expect(ui.diagnostics).toEqual([]);
});
it("refuses links and an empty reserved browser directory", async () => {
  const root = path.join(await temp(), "probe");
  await mkdir(path.join(root, "ui/page/__covel__"), { recursive: true });
  for (const [file, content] of Object.entries({
    "PLUGIN.md": md({ ...base, ...view }),
    ...browser,
  }))
    await writeFile(path.join(root, file), content);
  const discovery = await discoverPluginAt(root);
  expect(
    (await loadPluginDefinition(discovery!)).executionAssessment?.mode,
  ).toBe("code");
  await symlink("app.js", path.join(root, "ui/page/link.js"));
  expect(
    (await loadPluginDefinition(discovery!)).executionAssessment?.mode,
  ).toBe("unknown");
  await expect(readPackageInventory(root)).rejects.toThrow(/linked/);
});

it("keeps empty declarations and an agent output contract declarative", () => {
  expect(
    assess({
      permissions: { http: [] },
      contributes: {
        hooks: [],
        tools: [],
        actions: [],
        forms: [],
        wires: [],
        services: [],
        extensions: [],
      },
      runtime: {
        schedule: { stage: "post-turn" },
        io: { output: { contract: "notebook.result@1" } },
        permissions: { http: [] },
      },
    }).mode,
  ).toBe("declarative");
});
it("a broken data-only UI does not manufacture executable evidence", () => {
  expect(assess(view, { "ui/page.json": "invalid JSON" }).mode).toBe(
    "declarative",
  );
});
it("ignores an authored classification claim when executable files exist", () => {
  expect(
    assess(
      { executionMode: "declarative", trust: "builtin" },
      { "test.jsx": "code" },
    ).mode,
  ).toBe("code");
});
