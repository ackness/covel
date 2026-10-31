import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginUiSpecs, validatePluginFiles } from "../src/index.js";
import { parsePluginMd } from "../src/parse-plugin-md.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const view = {
  component: "Prose",
  props: { content: { $state: "/segment/text" } },
};
const valid = { id: "nameplate", match: { kind: "dialogue" }, view };

const invalid: Record<string, { spec: unknown; path: string }> = {
  "no-match": { spec: { view }, path: "match" },
  "empty-match": { spec: { match: {}, view }, path: "match" },
  webview: {
    spec: { match: { kind: "dialogue" }, webview: { entry: "a.html" } },
    path: "webview",
  },
  "data-source": {
    spec: { match: { kind: "dialogue" }, view, dataSource: { namespace: "x" } },
    path: "dataSource",
  },
  action: {
    spec: {
      match: { speaker: "Ana" },
      view: { ...view, on: { press: { action: "sendMessage" } } },
    },
    path: "view.on",
  },
};

async function plugin(specs: Record<string, unknown>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "covel-ui-segment-"));
  roots.push(temp);
  const dir = path.join(temp, "segment-probe");
  await mkdir(path.join(dir, "ui"), { recursive: true });
  const declared = Object.keys(specs).map((name) => `./ui/${name}.json`);
  await writeFile(
    path.join(dir, "PLUGIN.md"),
    `---\n${JSON.stringify({ id: "segment-probe", kind: "plugin", description: "Probe", contributes: { ui: { segment: declared } } })}\n---\n`,
  );
  for (const [name, spec] of Object.entries(specs))
    await writeFile(path.join(dir, "ui", `${name}.json`), JSON.stringify(spec));
  return { dir, declared };
}

function validate(dir: string): string | undefined {
  const sourcePath = path.join(dir, "PLUGIN.md");
  const root = parsePluginMd(readFileSync(sourcePath, "utf8"), sourcePath);
  try {
    validatePluginFiles(root, [], (file) => readFileSync(file, "utf8"));
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("segment template loading", () => {
  it("loads valid templates under the segment placement", async () => {
    const { dir, declared } = await plugin({ nameplate: valid });
    expect(validate(dir)).toBeUndefined();
    const loaded = await loadPluginUiSpecs(dir, "segment-probe", {
      segment: declared,
    });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.slots.segment).toEqual([valid]);
  });

  it("reports the same problems while the valid sibling still loads", async () => {
    for (const [name, { spec, path: issuePath }] of Object.entries(invalid)) {
      const { dir, declared } = await plugin({
        nameplate: valid,
        [name]: spec,
      });
      const loaded = await loadPluginUiSpecs(dir, "segment-probe", {
        segment: declared,
      });
      expect(loaded.slots.segment, name).toEqual([valid]);
      expect(loaded.diagnostics, name).toHaveLength(1);
      const [diagnostic] = loaded.diagnostics;
      expect(diagnostic).toMatchObject({
        slot: "segment",
        specIndex: 1,
        declaredPath: `./ui/${name}.json`,
      });
      const issue = diagnostic!.issues.find(
        (entry) => entry.path === issuePath,
      );
      expect(issue, name).toBeDefined();
      expect(validate(dir), name).toContain(
        `contributes.ui.segment: ./ui/${name}.json: ${issue!.path}: ${issue!.message}`,
      );
    }
  });
});
