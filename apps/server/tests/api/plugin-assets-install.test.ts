// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validatePluginBundle } from "../../src/routes/api/install/plugin-bundle.js";
import type { ExtractedEntry } from "../../src/routes/api/install/shared.js";

const entries = (extra: Record<string, string> = {}): ExtractedEntry[] =>
  Object.entries({
    "PLUGIN.md":
      "---\nid: page-probe\ndescription: Page\ncontributes:\n  ui:\n    view: [./ui/view.json]\n---\n",
    "ui/view.json": JSON.stringify({
      id: "page",
      label: "Page",
      webview: { root: "./ui/app", entry: "index.html" },
    }),
    "ui/app/index.html": "<head></head>",
    "ui/app/app.js": "// page",
    ...extra,
  }).map(([relativePath, content]) => ({
    relativePath,
    content: Buffer.from(content),
  }));

describe("multi-file page installation validation", () => {
  it("lists an in-memory root relative to the package, without reading HTML inline", () => {
    expect(
      validatePluginBundle(
        entries({ "ui/app/index.html": "x".repeat(513 * 1024) }),
        new Set(),
      ).pluginId,
    ).toBe("page-probe");
  });
  it.each<{ extra: Record<string, string>; message: string }>([
    {
      extra: { "ui/app/__covel__/x.js": "" },
      message: "the name __covel__ is reserved",
    },
    { extra: { "ui/app/PLUGIN.md": "" }, message: "not the package root" },
    {
      extra: {
        "ui/view.json": JSON.stringify({
          id: "page",
          label: "Page",
          webview: { root: "ui/absent", entry: "index.html" },
        }),
      },
      message: "entry is missing",
    },
  ])(
    "reports planner issues before installing files $message",
    ({ extra, message }) => {
      expect(() => validatePluginBundle(entries(extra), new Set())).toThrow(
        message,
      );
    },
  );
});

it("assesses the exact community distribution identically in archive and filesystem paths", async () => {
  const { readPackageInventory, discoverPluginAt, loadPluginDefinition } =
    await import("@covel/plugin-loader");
  const path = await import("node:path");
  const root = path.resolve(
    import.meta.dirname,
    "../../../../tests/third-party/declarative-notebook",
  );
  const inventory = await readPackageInventory(root);
  const entries = inventory.files.map((file) => ({
    relativePath: file.relativePath,
    content: Buffer.from(file.content),
  }));
  const bundle = validatePluginBundle(
    entries,
    new Set(),
    "declarative-notebook",
  );
  const definition = await loadPluginDefinition(
    (await discoverPluginAt(root))!,
  );
  expect(bundle.executionMode).toBe("declarative");
  expect(bundle.executionMode).toBe(definition.executionAssessment?.mode);
  expect(bundle.hasServerCode).toBe(false);
  expect(bundle.capabilities.serverCode).toBe(false);
  expect(bundle.capabilities.datasets).toContainEqual(
    expect.objectContaining({ namespace: "notes" }),
  );
});
