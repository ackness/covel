// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  describeAuthoringSurface,
  validateAuthoringExamples,
} from "../../src/authoring/describe.js";
import { loadPluginCatalogue } from "../../src/world-data/validate-world-package.js";
import { resolveWorldDataSchema } from "../../src/world-data/schema-registry.js";
import {
  portableContractSources,
  worldGenerationDataContracts,
} from "../../src/world-data/portable-contract-data.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "authoring-failures-"));
  const plugin = path.join(root, "sample");
  await mkdir(plugin);
  await writeFile(
    path.join(plugin, "PLUGIN.md"),
    `---
id: sample
kind: plugin
description: Example data
contracts:
  sample.good@1: { schema: good.json }
  sample.bad@1: { schema: bad.json }
contributes:
  data:
    good:
      schema: good.json
      version: 1
      accepts: [sample.good@1]
      authoring: { title: Good, example: good-example.json, generate: offer, source: { path: data/good.json } }
    bad:
      schema: bad.json
      version: 1
      accepts: [sample.bad@1]
      authoring: { title: Bad, example: bad-example.json, generate: offer, source: { path: data/bad.json } }
---
`,
  );
  for (const name of ["good", "bad"]) {
    await writeFile(
      path.join(plugin, `${name}.json`),
      JSON.stringify({ type: "object" }),
    );
    await writeFile(path.join(plugin, `${name}-example.json`), "{}");
  }
  const catalogue = await loadPluginCatalogue([root]);
  expect(catalogue.get("sample")?.status).not.toBe("error");
  return { plugin, catalogue };
}

describe("authoring failure isolation", () => {
  it.each(["invalid JSON", "directory", "missing file"])(
    "skips only the namespace with an example that is %s",
    async (failure) => {
      const { plugin, catalogue } = await fixture();
      const file = path.join(plugin, "bad-example.json");
      if (failure === "invalid JSON") await writeFile(file, "{");
      else {
        await rm(file);
        if (failure === "directory") await mkdir(file);
      }
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const surface = await describeAuthoringSurface(catalogue);
        expect(surface.diagnostics).toEqual([
          expect.objectContaining({ pluginId: "sample", namespace: "bad" }),
        ]);
        expect(surface.contracts.map((item) => item.contract)).toEqual([
          "sample.good@1",
        ]);
        expect(await validateAuthoringExamples(catalogue)).toEqual([
          expect.objectContaining({ pluginId: "sample", namespace: "bad" }),
        ]);
        expect(
          (await worldGenerationDataContracts(catalogue)).map(
            (item) => item.contract,
          ),
        ).toEqual(["sample.good@1"]);
        expect(warn.mock.calls.flat().join(" ")).toContain("sample/bad");
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("ignores a failed provider when resolving an otherwise healthy contract", async () => {
    const { plugin, catalogue } = await fixture();
    const entry = catalogue.get("sample")!;
    const entries = new Map(catalogue.getAll());
    entries.set("failed", {
      ...entry,
      id: "failed",
      status: "error",
      rootPath: path.join(plugin, "missing"),
    });
    catalogue.getAll = () => entries;
    const source = portableContractSources([
      { contract: "sample.good@1", key: "entry", value: { id: "entry" } },
    ])[0];
    if (!source) throw new Error("Missing test source");
    const schema = await resolveWorldDataSchema({
      source,
      deps: { registry: catalogue },
    });
    expect(schema).toMatchObject({ kind: "local" });
  });

  it.each(["missing", "invalid", "conflicting"])(
    "skips only a contract with a %s schema",
    async (failure) => {
      const { plugin, catalogue } = await fixture();
      if (failure === "missing") await rm(path.join(plugin, "bad.json"));
      else if (failure === "invalid")
        await writeFile(path.join(plugin, "bad.json"), "{");
      else {
        const entry = catalogue.get("sample")!;
        const other = path.join(plugin, "other");
        await mkdir(other);
        await writeFile(
          path.join(other, "bad.json"),
          JSON.stringify({ type: "string" }),
        );
        const entries = new Map(catalogue.getAll());
        entries.set("conflict", {
          ...entry,
          id: "conflict",
          rootPath: other,
          packageManifest: {
            ...entry.packageManifest!,
            plugin: {
              ...entry.packageManifest!.plugin,
              contributes: {},
              contracts: { "sample.bad@1": { schema: "bad.json" } },
            },
          },
        });
        catalogue.getAll = () => entries;
      }
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(
          (await worldGenerationDataContracts(catalogue)).map(
            (item) => item.contract,
          ),
        ).toEqual(["sample.good@1"]);
        expect(warn.mock.calls.flat().join(" ")).toContain("sample.bad@1");
      } finally {
        warn.mockRestore();
      }
    },
  );
});
