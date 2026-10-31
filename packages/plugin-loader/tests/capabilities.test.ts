import { describe, expect, it } from "vitest";
import {
  computePluginCapabilities,
  packageHasServerCode,
} from "../src/capabilities.js";
import {
  parsePluginMd,
  compileInlineRuntime,
  parseRuntimeMd,
} from "../src/parse-plugin-md.js";
const md = (value: object) => `---\n${JSON.stringify(value)}\n---\nPrompt`;
const parse = (value: object) =>
  parsePluginMd(
    md({ id: "probe", description: "Probe", ...value }),
    "probe/PLUGIN.md",
  );
describe("package capability snapshots", () => {
  it("keeps a prompt-only package empty", () => {
    const root = parse({});
    expect(
      computePluginCapabilities({ root, runtimes: [], hasServerCode: false }),
    ).toEqual({
      serverCode: false,
      http: [],
      hooks: [],
      tools: [],
      actions: [],
      services: [],
      wires: [],
      extensions: [],
      forms: [],
      datasets: [],
    });
  });
  it("unions package/runtime HTTP and tools and records declared datasets and service contracts", () => {
    const root = parse({
      entry: "./server.js",
      permissions: { http: [{ origin: "https://a.test", methods: ["POST"] }] },
      contributes: {
        tools: ["z", "a"],
        actions: ["act"],
        services: [
          "probe@1",
          { contract: "probe.read@1", modelFacing: true },
          { contract: "probe.write@1", access: "write", modelFacing: true },
        ],
        wires: ["wire"],
        forms: ["form"],
        extensions: ["prompt.segment@1/probe"],
        hooks: [
          { event: "PreToolUse", enforce: "pre" },
          "PostToolUse",
          { event: "TurnStop", enforce: "post" },
        ],
        datasets: {
          notes: { schema: "notes.schema.json", ops: ["set", "delete"] },
        },
      },
      runtime: {
        schedule: { trigger: { type: "manual" } },
        agent: { tools: { builtin: ["z", "read"] } },
        permissions: {
          http: [
            { origin: "https://a.test" },
            { origin: "https://b.test", methods: ["HEAD"] },
          ],
        },
      },
    });
    const inline = compileInlineRuntime(root);
    if (!inline) throw new Error("Missing inline runtime");
    expect(
      computePluginCapabilities({
        root,
        runtimes: [inline],
        hasServerCode: true,
      }),
    ).toEqual({
      serverCode: true,
      http: [
        { origin: "https://a.test", methods: ["GET", "POST"] },
        { origin: "https://b.test", methods: ["HEAD"] },
      ],
      hooks: [
        { event: "PostToolUse", enforce: "normal" },
        { event: "PreToolUse", enforce: "pre" },
        { event: "TurnStop", enforce: "post" },
      ],
      tools: ["a", "read", "z"],
      actions: ["act"],
      // A service offered to models is still recorded by its contract; a
      // write service is marked, so gaining write access asks again.
      services: ["probe.read@1", "probe.write@1 (write)", "probe@1"],
      wires: ["wire"],
      extensions: ["prompt.segment@1/probe"],
      forms: ["form"],
      datasets: [{ namespace: "notes", ops: ["delete", "set"] }],
    });
  });
  it("does not depend on runtime ordering", () => {
    const root = parse({});
    const runtimes = ["b", "a"].map((id) =>
      parseRuntimeMd(
        md({
          schedule: { trigger: { type: "manual" } },
          agent: { tools: { builtin: [id] } },
          permissions: { http: [{ origin: `https://${id}.test` }] },
        }),
        `probe/runtimes/${id}/RUNTIME.md`,
        root.plugin,
      ),
    );
    expect(
      computePluginCapabilities({ root, runtimes, hasServerCode: false }),
    ).toEqual(
      computePluginCapabilities({
        root,
        runtimes: [...runtimes].reverse(),
        hasServerCode: false,
      }),
    );
  });
  it.each(["js", "mjs", "cjs", "ts", "mts", "cts", "tsx", "wasm", "node"])(
    "recognizes .%s code files",
    (extension) =>
      expect(packageHasServerCode([`unused.${extension}`], parse({}), [])).toBe(
        true,
      ),
  );
  it("also recognizes imports and leaves data files alone", () => {
    expect(
      packageHasServerCode(["PLUGIN.md", "data.json"], parse({}), []),
    ).toBe(false);
    expect(packageHasServerCode([], parse({ entry: "./server.js" }), [])).toBe(
      true,
    );
  });
});
