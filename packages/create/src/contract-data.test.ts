import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  ).toEqual([]);
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
