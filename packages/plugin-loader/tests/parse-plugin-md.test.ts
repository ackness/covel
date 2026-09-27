import { describe, expect, it } from "vitest";
import { parsePluginMd, parseRuntimeMd } from "../src/parse-plugin-md.js";
const md = (value: object, body = "Prompt") =>
  `---\n${JSON.stringify(value)}\n---\n${body}`;
const root = { id: "probe", kind: "plugin", description: "Probe" };
describe("current authoring manifests", () => {
  it("keeps contribution-only packages free of execution", () => {
    const parsed = parsePluginMd(
      md({ ...root, entry: "./server.js", contributes: { tools: ["probe"] } }),
      "probe/PLUGIN.md",
    );
    expect(parsed.plugin?.contributes?.tools).toEqual(["probe"]);
    expect(parsed.runtime).toBeUndefined();
    expect(parsed.manifest.runtimeType).toBeUndefined();
  });
  it("compiles grouped scheduling, loop, outputs and own data", () => {
    const parsed = parsePluginMd(
      md({
        ...root,
        provides: [{ contract: "probe@1", default: true }],
        runtime: {
          type: "agent",
          schedule: {
            stage: "post-turn",
            trigger: { type: "auto" },
            needs: [{ contract: "upstream@1" }],
          },
          io: {
            visibility: "system",
            output: { contract: "probe@1" },
            selfData: [{ namespace: "notes", as: "notes" }],
            inputs: {
              upstream: {
                from: { runtime: "upstream" },
                select: "/value",
                required: false,
              },
            },
          },
          agent: {
            model: "plugin",
            loop: {
              maxSteps: 4,
              completion: { require: "explicit", afterTools: ["save"] },
            },
          },
        },
      }),
      "probe/PLUGIN.md",
    );
    expect(parsed.manifest).toMatchObject({
      name: "probe",
      pluginId: "probe",
      stage: "post-turn",
      outputContract: "probe@1",
      defaultProvider: true,
      maxSteps: 4,
      requireExplicitCompletion: true,
      completeAfterTools: ["save"],
    });
    expect(parsed.manifest.inputs?.upstream.required).toBe(false);
    expect(parsed.manifest.input?.inject).toEqual([
      {
        kind: "plugin-data",
        namespace: "notes",
        as: "notes",
        format: "summary",
        maxEntries: 50,
      },
    ]);
  });
  it("derives child identity from the directory and accepts function configuration", () => {
    const plugin = parsePluginMd(md(root), "probe/PLUGIN.md").plugin!;
    const parsed = parseRuntimeMd(
      md({
        type: "function",
        schedule: {
          trigger: { type: "manual" },
          manual: { execution: "background" },
        },
        function: { handler: "./handler.js" },
      }),
      "probe/runtimes/import/RUNTIME.md",
      plugin,
    );
    expect(parsed.manifest).toMatchObject({
      name: "probe/import",
      pluginId: "probe",
      runtimeType: "function",
      handler: "./handler.js",
      execution: "background",
    });
  });
  it("compiles a function tool allowlist and rejects an additional agent configuration", () => {
    const runtime = {
      type: "function",
      schedule: { trigger: { type: "manual" } },
      function: {
        handler: "./handler.js",
        timeoutMs: 90000,
        tools: { builtin: ["get-character"], plugin: ["inspect"] },
      },
    };
    const parsed = parsePluginMd(md({ ...root, runtime }), "probe/PLUGIN.md");
    expect(parsed.manifest.tools).toEqual({
      builtin: ["get-character"],
      plugin: ["inspect"],
    });
    expect(parsed.manifest.timeoutMs).toBe(90000);
    expect(() =>
      parsePluginMd(
        md({
          ...root,
          runtime: {
            ...runtime,
            agent: { tools: { builtin: ["list-characters"] } },
          },
        }),
        "probe/PLUGIN.md",
      ),
    ).toThrow("cannot declare agent");
  });
  it("compiles committed and kernel inputs without turning them into turn dependencies", () => {
    const parsed = parsePluginMd(
      md({
        ...root,
        runtime: {
          type: "function",
          function: { handler: "./handler.js" },
          io: {
            inputs: {
              digest: { from: { kernel: "turn-digest@1" } },
              cached: {
                from: { contract: "probe.cache@1" },
                scope: "committed",
                recordAs: "cache",
                required: false,
              },
            },
          },
        },
      }),
      "probe/PLUGIN.md",
    );
    expect(parsed.manifest.inputs).toBeUndefined();
    expect(parsed.manifest.input?.inject).toEqual([
      { kind: "kernel", from: "turn-digest@1", name: "digest" },
      {
        kind: "runtime-export",
        name: "cached",
        from: { capability: "probe.cache@1" },
        recordAs: "cache",
        required: false,
      },
    ]);
  });
  it.each([
    "name",
    "pluginType",
    "stage",
    "capabilities",
    "relations",
    "authorsNote",
    "postHistory",
    "dataSchemas",
    "memoryBlocks",
  ])("rejects removed root field %s", (key) => {
    expect(() =>
      parsePluginMd(md({ ...root, [key]: "legacy" }), "probe/PLUGIN.md"),
    ).toThrow("invalid manifest");
  });
  it.each([
    { id: "child" },
    { name: "child" },
    { entry: "./server.js" },
    { contributes: { tools: ["x"] } },
    { type: "function" },
    { type: "agent", function: { handler: "./x.js" } },
  ])("rejects invalid runtime declaration %j", (fields) => {
    const plugin = parsePluginMd(md(root), "probe/PLUGIN.md").plugin!;
    expect(() =>
      parseRuntimeMd(
        md({ type: "agent", ...fields }),
        "probe/runtimes/run/RUNTIME.md",
        plugin,
      ),
    ).toThrow();
  });
  it("rejects role tags, unversioned contracts and unknown grouped fields", () => {
    for (const fields of [
      { tags: ["role:narrator"] },
      { provides: ["probe"] },
      { runtime: { type: "agent", agent: { unknown: true } } },
    ])
      expect(() =>
        parsePluginMd(md({ ...root, ...fields }), "probe/PLUGIN.md"),
      ).toThrow();
  });
  it("preserves source and Markdown body while folding localized description", () => {
    const parsed = parsePluginMd(
      md({ ...root, description: { en: "English", zh: "中文" } }, "Body\n"),
      "probe/PLUGIN.md",
    );
    expect(parsed.manifest.description).toBe("English");
    expect(parsed.promptTemplate).toBe("Body\n");
    expect(parsed.sourcePath).toBe("probe/PLUGIN.md");
  });
});
