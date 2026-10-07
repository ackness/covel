import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import {
  applyCreationBriefToManifest,
  normalizeGeneratedPackage,
} from "./package-processor.js";
import { writeWorldDataFiles } from "./world-writer.js";

const contract = {
  contract: "custom.definition@1",
  schema: { type: "object" },
  validate: (value: unknown) =>
    Boolean(value && typeof value === "object" && "description" in value),
};
const record = {
  contract: contract.contract,
  key: "world",
  value: { id: "world", description: "A custom definition" },
};

const brief = { contracts: [contract.contract] };

it("validates requested contract records without a gameplay schema dependency", () => {
  expect(
    normalizeGeneratedPackage({ contractData: [record] }, brief, [contract]),
  ).toMatchObject({ errors: [], content: { contractData: [record] } });
  for (const records of [
    [{ ...record, contract: "unknown@1" }],
    [{ ...record, value: { id: "world" } }],
    [{ ...record, key: "mismatch" }],
    [record, record],
  ]) {
    expect(
      normalizeGeneratedPackage({ contractData: records }, brief, [contract])
        .errors.length,
    ).toBeGreaterThan(0);
  }
});

it("accepts records only for contracts the brief requests, and requires each requested one", () => {
  // Available but not requested: the model must not volunteer it.
  expect(
    normalizeGeneratedPackage({ contractData: [record] }, {}, [contract])
      .errors,
  ).toEqual([
    `contractData[0] uses contract "${contract.contract}", which the creation brief did not request`,
  ]);
  // Requested but missing: the attempt fails so the generator retries.
  expect(normalizeGeneratedPackage({}, brief, [contract]).errors).toEqual([
    `contractData must include at least one record for contract "${contract.contract}"`,
  ]);
});

it("requests the receiving plugin of every selected contract", () => {
  const manifest: Record<string, unknown> = {
    pluginPolicy: { requested: ["narrator"] },
  };
  expect(
    applyCreationBriefToManifest(manifest, brief, [
      { ...contract, pluginId: "custom-plugin" },
    ]),
  ).toEqual({ errors: [], warnings: [] });
  expect(manifest.pluginPolicy).toMatchObject({
    presetId: "traditional-story",
    requested: ["narrator", "custom-plugin"],
  });
});

it("writes portable contract records as validated contract-targeted world sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-contract-data-"));
  try {
    const manifest: Record<string, unknown> = {};
    const content = normalizeGeneratedPackage(
      { contractData: [record] },
      brief,
      [contract],
    ).content;
    await writeWorldDataFiles(root, manifest, content);
    const descriptor = parse(
      await readFile(path.join(root, String(manifest.worldData)), "utf8"),
    );
    expect(descriptor.sources.contract0).toEqual({
      kind: "json",
      path: "data/contract-0.json",
      schema: `contract:${contract.contract}`,
      to: `contract:${contract.contract}`,
      key: "id",
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(root, descriptor.sources.contract0.path),
          "utf8",
        ),
      ),
    ).toEqual(record.value);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("writes a contract's records to the file its plugin names, with no descriptor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-contract-data-"));
  try {
    const manifest: Record<string, unknown> = {};
    const content = normalizeGeneratedPackage(
      { contractData: [record] },
      brief,
      [contract],
    ).content;
    const written = await writeWorldDataFiles(root, manifest, content, [
      {
        contract: contract.contract,
        source: { kind: "yaml", path: "data/custom.yaml" },
      },
    ]);
    expect(written).toEqual(["data/custom.yaml"]);
    expect(manifest.worldData).toBeUndefined();
    // One record is the file's content; the plugin's path decides the format.
    expect(
      parse(await readFile(path.join(root, "data/custom.yaml"), "utf8")),
    ).toEqual(record.value);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("writes no contract file outside the package", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "covel-contract-data-"));
  try {
    const root = path.join(parent, "package");
    const content = normalizeGeneratedPackage(
      { contractData: [record] },
      brief,
      [contract],
    ).content;
    for (const escaping of ["../escaped.json", path.join(parent, "abs.json")])
      await expect(
        writeWorldDataFiles(root, {}, content, [
          {
            contract: contract.contract,
            source: { kind: "json", path: escaping },
          },
        ]),
      ).rejects.toThrow("outside the package");
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("gives each contract its own file when two name the same one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-contract-data-"));
  try {
    const manifest: Record<string, unknown> = {};
    const names = ["first.records@1", "second.records@1", "third.records@1"];
    const paths = ["data/shared.json", "Data/Shared.json", "world.yaml"];
    await writeWorldDataFiles(
      root,
      manifest,
      {
        characters: [],
        lorebook: [],
        rules: [],
        contractData: names.map((name) => ({
          contract: name,
          key: name,
          value: { id: name },
        })),
      },
      names.map((name, index) => ({
        contract: name,
        source: {
          kind: "json" as const,
          path: paths[index]!,
          localeArrayKeys: ["label"],
        },
      })),
    );
    // The descriptor says where each contract's records are; without it the
    // shared path would be read for neither.
    const { sources } = parse(
      await readFile(path.join(root, String(manifest.worldData)), "utf8"),
    );
    const files = names.map((_, index) => sources[`contract${index}`].path);
    expect(files).toEqual([
      "data/shared.json",
      "data/contract-1.json",
      "data/contract-2.json",
    ]);
    for (const index of names.keys())
      expect(sources[`contract${index}`].localeArrayKeys).toEqual(["label"]);
    for (const [index, file] of files.entries())
      expect(JSON.parse(await readFile(path.join(root, file), "utf8"))).toEqual(
        { id: names[index] },
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("targets the lorebook projection when the receiver declares it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-contract-data-"));
  try {
    const manifest: Record<string, unknown> = {};
    const content = normalizeGeneratedPackage(
      { contractData: [record] },
      brief,
      [{ ...contract, lorebook: true }],
    ).content;
    await writeWorldDataFiles(root, manifest, content);
    const descriptor = parse(
      await readFile(path.join(root, String(manifest.worldData)), "utf8"),
    );
    expect(descriptor.sources.contract0.to).toBe(
      `contract:${contract.contract}+lorebook`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("accepts a requested kind that falls short of its target, with a warning", () => {
  const lorebook = [
    { id: "tide-calendar", content: "The tide follows the calendar." },
    { id: "clock-tower", content: "The tower keeps the tide log." },
  ];
  const result = normalizeGeneratedPackage(
    { lorebook },
    { content: ["lorebook"] },
  );
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([
    "generated 2 lorebook entries; the brief asks for 4",
  ]);
  expect(result.content.lorebook).toHaveLength(2);
});

it("still rejects a requested kind that is missing entirely", () => {
  const result = normalizeGeneratedPackage(
    { lorebook: [] },
    { content: ["lorebook", "rules"] },
  );
  expect(result.errors).toEqual([
    "WORLD_PACKAGE_YAML must include lorebook entries",
    "WORLD_PACKAGE_YAML must include rules",
  ]);
});

it("reports an opening kit with too few numeric resources as a warning", () => {
  const manifest: Record<string, unknown> = {
    dimensions: {
      coins: { name: "Coins", schema: { type: "integer" }, initialValue: 8 },
      opening: {
        name: "Opening",
        schema: { type: "string" },
        initialValue: "",
      },
    },
  };
  expect(
    applyCreationBriefToManifest(manifest, { content: ["opening-kit"] }),
  ).toEqual({
    errors: [],
    warnings: [
      "opening kit has 1 numeric resource dimensions; the brief asks for 2",
    ],
  });
});
