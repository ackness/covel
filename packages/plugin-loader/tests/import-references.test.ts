import path from "node:path";
import { expect, it } from "vitest";
import {
  compileInlineRuntime,
  parsePluginMd,
  parseRuntimeMd,
  pluginImportReferences,
  validatePluginFiles,
} from "../src/index.js";

const root = parsePluginMd(
  `---
id: probe
kind: plugin
description: Test fixture
entry: ./entry.js
contributes:
  data:
    records:
      version: 1
      schema: ./records.json
      accepts: [projected@1]
  worldProjections:
    records:
      from: source@1
      handler: ./projection.cjs
      outputs:
        rows: { namespace: records, key: id }
---
`,
  "probe/PLUGIN.md",
);

it("enumerates entry, projection, function and guard paths with their owning manifests", () => {
  const child = parseRuntimeMd(
    `---
type: function
schedule: { trigger: { type: manual } }
function: { handler: ./handler.mts }
guard: ./guard.cts
---
`,
    "probe/runtimes/run/RUNTIME.md",
    root.plugin,
  );
  expect(pluginImportReferences(root, [child])).toEqual([
    { source: "probe/PLUGIN.md", field: "entry", reference: "./entry.js" },
    {
      source: "probe/PLUGIN.md",
      field: "contributes.worldProjections.records.handler",
      reference: "./projection.cjs",
    },
    {
      source: "probe/runtimes/run/RUNTIME.md",
      field: "function.handler",
      reference: "./handler.mts",
    },
    {
      source: "probe/runtimes/run/RUNTIME.md",
      field: "guard",
      reference: "./guard.cts",
    },
  ]);
  const read: string[] = [];
  validatePluginFiles(root, [child], (file) => {
    read.push(file);
    return "{}";
  });
  for (const { source, reference } of pluginImportReferences(root, [child])) {
    if (!source) throw new Error("An import must have its owning manifest");
    expect(read).toContain(path.resolve(path.dirname(source), reference));
  }
});

it("enumerates inline runtime imports and leaves prompt-only packages empty", () => {
  const prompt = parsePluginMd(
    "---\nid: prompt\nkind: plugin\ndescription: Test fixture\n---\n",
    "prompt/PLUGIN.md",
  );
  expect(pluginImportReferences(prompt, [])).toEqual([]);
  const inline = parsePluginMd(
    `---
id: inline
kind: plugin
description: Test fixture
runtime:
  type: function
  schedule: { trigger: { type: manual } }
  function: { handler: ./handler.js }
---
`,
    "inline/PLUGIN.md",
  );
  const runtime = compileInlineRuntime(inline);
  expect(runtime).toBeDefined();
  expect(pluginImportReferences(inline, runtime ? [runtime] : [])).toEqual([
    {
      source: "inline/PLUGIN.md",
      field: "function.handler",
      reference: "./handler.js",
    },
  ]);
});
