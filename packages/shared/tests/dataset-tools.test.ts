import { describe, expect, it } from "vitest";
import {
  datasetToolKinds,
  datasetToolName,
  pluginManifestSchema,
  runtimeManifestInputSchema,
} from "../src/index.js";

describe("datasetToolKinds", () => {
  it.each([
    { ops: undefined, kinds: ["get", "list", "upsert", "update"] },
    { ops: ["merge", "inc"], kinds: ["get", "list", "update"] },
    { ops: ["set"], kinds: ["get", "list", "upsert"] },
    { ops: ["set", "delete"], kinds: ["get", "list", "upsert", "update"] },
    { ops: ["delete"], kinds: ["get", "list", "update"] },
  ] as const)("derives $kinds from ops $ops", ({ ops, kinds }) => {
    expect(datasetToolKinds(ops ? { ops } : {})).toEqual(kinds);
  });

  it("keeps written tools", () => {
    expect(datasetToolKinds({ ops: ["set"], tools: ["list"] })).toEqual([
      "list",
    ]);
  });

  it("names a tool after its dataset and kind", () => {
    expect(datasetToolName("npcs", "upsert")).toBe("npcs-upsert");
  });
});

function packageIssues(dataset: Record<string, unknown>): string[] {
  const result = pluginManifestSchema.safeParse({
    id: "probe",
    kind: "plugin",
    description: "Probe",
    contributes: { datasets: { notes: { schema: "./n.json", ...dataset } } },
  });
  return result.success
    ? []
    : result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
}

function compiledIssues(dataset: Record<string, unknown>): string[] {
  const result = runtimeManifestInputSchema.safeParse({
    name: "probe/teller",
    description: "Probe",
    runtimeType: "agent",
    stage: "narrative",
    trigger: { type: "auto" },
    datasets: {
      notes: { namespace: "notes", schema: "./n.json", ...dataset },
    },
  });
  return result.success
    ? []
    : result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
}

describe("dataset tools declaration", () => {
  it("accepts tools that the ops serve and a description", () => {
    expect(
      packageIssues({
        ops: ["set", "merge"],
        tools: ["get", "upsert", "update"],
        description: "Notes the agent keeps.",
      }),
    ).toEqual([]);
  });

  it("rejects upsert without set", () => {
    expect(packageIssues({ ops: ["merge"], tools: ["upsert"] })).toEqual([
      expect.stringMatching(
        /^contributes\.datasets\.notes\.tools\.0: upsert needs the set operation/,
      ),
    ]);
  });

  it("rejects update when ops are only set", () => {
    expect(packageIssues({ ops: ["set"], tools: ["get", "update"] })).toEqual([
      expect.stringMatching(
        /^contributes\.datasets\.notes\.tools\.1: update needs an operation other than set/,
      ),
    ]);
  });

  it("rejects duplicate tools and an overlong description", () => {
    expect(packageIssues({ tools: ["get", "get"] })).toHaveLength(1);
    expect(packageIssues({ description: "x".repeat(501) })).toHaveLength(1);
  });

  it("applies the same rule to the compiled declaration", () => {
    expect(
      compiledIssues({ ops: ["set"], tools: ["get", "list", "upsert"] }),
    ).toEqual([]);
    expect(compiledIssues({ ops: ["merge"], tools: ["upsert"] })).toEqual([
      expect.stringMatching(
        /^datasets\.notes\.tools\.0: upsert needs the set operation/,
      ),
    ]);
    expect(compiledIssues({ ops: ["set"], tools: ["update"] })).toEqual([
      expect.stringMatching(
        /^datasets\.notes\.tools\.0: update needs an operation other than set/,
      ),
    ]);
  });
});
