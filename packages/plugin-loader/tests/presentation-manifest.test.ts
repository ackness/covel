import { describe, expect, it } from "vitest";
import { getRuntimeSpec } from "@covel/shared";
import {
  parsePluginMd,
  parseRuntimeMd,
  compileInlineRuntime,
  RuntimeDisabledError,
} from "../src/parse-plugin-md.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPluginAt } from "../src/discover.js";
import { loadPluginDefinition } from "../src/load.js";
const runtime = {
  schedule: { stage: "post-turn" },
  presentation: {},
  function: {},
  effects: {
    reads: ["plugin-data:self:art", "plugin-data:self:display"],
    writes: ["plugin-data:self:display"],
  },
  io: {
    inputs: {
      story: { from: { contract: "narrative-engine@2" }, required: false },
    },
  },
};
const root = {
  id: "community-display",
  description: "Public display",
  contributes: { data: { art: { schema: "./art.json" } } },
};
const md = (value: unknown) => `---\n${JSON.stringify(value)}\n---\n`;
describe("presentation runtime loading", () => {
  it("isolates an invalid runtime beside a valid sibling and UI without importing handlers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "presentation-manifest-"));
    const plugin = join(dir, "community-display");
    try {
      for (const local of ["valid", "invalid"])
        await mkdir(join(plugin, "runtimes", local), { recursive: true });
      await writeFile(
        join(plugin, "PLUGIN.md"),
        md({
          id: "community-display",
          description: "Presentation isolation",
          contributes: { ui: { right: ["./panel.json"] } },
        }),
      );
      await writeFile(
        join(plugin, "panel.json"),
        JSON.stringify({
          id: "display",
          label: "Display",
          view: { component: "Text", props: { content: "Public display" } },
        }),
      );
      await writeFile(
        join(plugin, "runtimes/valid/RUNTIME.md"),
        md({
          ...runtime,
          effects: {
            reads: ["plugin-data:self:display"],
            writes: ["plugin-data:self:display"],
          },
        }),
      );
      await writeFile(
        join(plugin, "runtimes/invalid/RUNTIME.md"),
        md({ ...runtime, presentation: { budget: { calls: -1 } } }),
      );
      for (const local of ["valid", "invalid"])
        await writeFile(
          join(plugin, "runtimes", local, "handler.js"),
          'throw new Error("Manifest loading imported server code");',
        );
      const discovery = await discoverPluginAt(plugin);
      expect(discovery).toBeDefined();
      const definition = await loadPluginDefinition(discovery!);
      expect(definition.manifests.map(({ manifest }) => manifest.name)).toEqual(
        ["community-display/valid"],
      );
      expect(definition.disabledRuntimes).toHaveLength(1);
      expect(
        definition.packageManifest?.plugin.contributes?.ui?.right,
      ).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each([false, true])(
    "compiles inline and separate declarations with paid=%s",
    (paid) => {
      const declaration = paid
        ? {
            ...runtime,
            schedule: { stage: "post-turn", detached: true },
            presentation: { budget: { calls: 2, generations: 1 } },
          }
        : runtime;
      const inline = compileInlineRuntime(
        parsePluginMd(
          md({ ...root, runtime: declaration }),
          "/community-display/PLUGIN.md",
        ),
      )!;
      const parent = parsePluginMd(md(root), "/community-display/PLUGIN.md");
      const separate = parseRuntimeMd(
        md(declaration),
        "/community-display/runtimes/cues/RUNTIME.md",
        parent.plugin,
      );
      for (const parsed of [inline, separate]) {
        expect(parsed.manifest.presentation).toMatchObject({
          publicAssetNamespaces: ["art"],
        });
        expect(getRuntimeSpec(parsed.manifest).presentation?.budget).toEqual(
          paid ? { calls: 2, generations: 1 } : { calls: 0, generations: 0 },
        );
      }
    },
  );
  it("keeps an invalid inline runtime out while retaining package contributions", () => {
    const parsed = parsePluginMd(
      md({
        ...root,
        runtime: { ...runtime, presentation: { budget: { calls: -1 } } },
      }),
      "/community-display/PLUGIN.md",
    );
    expect(parsed.disabledRuntime?.message).toContain(
      "runtime.presentation.budget.calls",
    );
    expect(parsed.plugin.contributes?.data?.art).toBeDefined();
    expect(compileInlineRuntime(parsed)).toBeUndefined();
  });
  it.each([
    { ...runtime, presentation: false },
    { ...runtime, presentation: null },
    { ...runtime, presentation: { surprise: true } },
    {
      ...runtime,
      effects: {
        reads: ["plugin-data:self:private"],
        writes: ["plugin-data:self:display"],
      },
    },
    { ...runtime, function: undefined },
  ])(
    "disables unsafe separate runtimes with actionable paths",
    (declaration) => {
      const parent = parsePluginMd(md(root), "/community-display/PLUGIN.md");
      expect(() =>
        parseRuntimeMd(
          md(declaration),
          "/community-display/runtimes/cues/RUNTIME.md",
          parent.plugin,
        ),
      ).toThrow(RuntimeDisabledError);
    },
  );
  it("refuses a package requirement that activates a storyteller", () => {
    const parsed = parsePluginMd(
      md({ ...root, requires: ["narrative-engine@2"], runtime }),
      "/community-display/PLUGIN.md",
    );
    expect(() => compileInlineRuntime(parsed)).toThrow(/requires/);
  });
});
