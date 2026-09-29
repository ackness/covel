import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { normalizeGeneratedPackage } from "./package-processor.js";
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

it("validates generic contract records without a gameplay schema dependency", () => {
  expect(
    normalizeGeneratedPackage({ contractData: [record] }, undefined, [
      contract,
    ]),
  ).toMatchObject({ errors: [], content: { contractData: [record] } });
  for (const records of [
    [{ ...record, contract: "unknown@1" }],
    [{ ...record, value: { id: "world" } }],
    [{ ...record, key: "mismatch" }],
    [record, record],
  ]) {
    expect(
      normalizeGeneratedPackage({ contractData: records }, undefined, [
        contract,
      ]).errors.length,
    ).toBeGreaterThan(0);
  }
});

it("writes portable contract records as validated contract-targeted world sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-contract-data-"));
  try {
    const manifest: Record<string, unknown> = {};
    const content = normalizeGeneratedPackage(
      { contractData: [record] },
      undefined,
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

it("normalizes memory definitions into portable contract data and rejects duplicate targets", () => {
  const blocks = [
    {
      label: "tides",
      displayName: "Tides",
      extractionHint: "Track changing tides",
    },
    {
      label: "debts",
      displayName: "Debts",
      extractionHint: "Track favors owed",
    },
  ];
  const normalized = normalizeGeneratedPackage(
    { memoryDefinitions: blocks },
    { content: ["memory"] },
  );
  expect(normalized).toMatchObject({
    errors: [],
    content: {
      contractData: [
        {
          contract: "memory.blocks@1",
          key: "world",
          value: { id: "world", blocks },
        },
      ],
    },
  });
  const duplicate = normalizeGeneratedPackage(
    {
      memoryDefinitions: blocks,
      contractData: normalized.content.contractData,
    },
    { content: ["memory"] },
    [{ contract: "memory.blocks@1", schema: {}, validate: () => true }],
  );
  expect(duplicate.errors).toContain(
    "duplicate contractData record: memory.blocks@1/world",
  );
});
