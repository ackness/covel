import { describe, expect, it } from "vitest";
import { parsePluginMd } from "@covel/plugin-loader";
import {
  datasetFailure,
  datasetPolicyResolver,
  type DatasetPolicy,
} from "../src/plugin-data-validation.js";

const schema = {
  type: "object",
  required: ["text"],
  properties: { text: { type: "string" } },
};
const policy: DatasetPolicy = {
  namespace: "notes",
  ops: ["set", "delete"],
  schema,
};

describe("shared dataset destination validation", () => {
  it.each([
    ["valid set", policy, ["set"], { value: { text: "ok" } }, undefined],
    [
      "refused set",
      { ...policy, ops: ["inc"] },
      ["set"],
      { value: { text: "ok" } },
      "not allowed",
    ],
    ["valid delete without a record", policy, ["delete"], undefined, undefined],
    [
      "refused delete",
      { ...policy, ops: ["set"] },
      ["delete"],
      undefined,
      "not allowed",
    ],
    [
      "invalid record",
      policy,
      ["set"],
      { value: { text: 1 } },
      "record does not match",
    ],
    ["undeclared namespace", undefined, ["set"], { value: null }, undefined],
    [
      "missing document",
      { namespace: "notes", ops: ["set"] },
      ["set"],
      { value: {} },
      "unavailable",
    ],
    [
      "uncompilable document",
      { ...policy, schema: { type: "invalid" } },
      ["set"],
      { value: {} },
      "schema is invalid",
    ],
    [
      "asynchronous document",
      { ...policy, schema: { $async: true, type: "object" } },
      ["set"],
      { value: {} },
      "schema is invalid",
    ],
  ] as const)("%s", (_name, target, ops, result, message) => {
    const failure = datasetFailure("write", target, ops, result);
    if (message) {
      expect(failure).toMatchObject({
        committed: false,
        code: "dataset-violation",
      });
      expect(failure?.error).toContain(message);
    } else expect(failure).toBeUndefined();
  });

  it("retains defaulted operations, schema identity and missing-document policies", () => {
    const manifest = parsePluginMd(
      `---\nid: probe\nkind: plugin\ndescription: Probe\ncontributes:\n  datasets:\n    notes:\n      schema: ./notes.json\n      key: text\n---`,
      "probe/PLUGIN.md",
    );
    const datasets = manifest.manifest.datasets;
    expect(datasets).toBeDefined();
    const resolver = datasetPolicyResolver([{ pluginId: "probe", datasets }], {
      probe: { notes: schema },
    });
    expect(resolver?.("probe", "notes")?.schema).toBe(schema);
    expect(
      datasetFailure("write", resolver?.("probe", "notes"), ["delete"]),
    ).toBeUndefined();
    expect(
      datasetPolicyResolver([{ pluginId: "probe", datasets }])?.(
        "probe",
        "notes",
      ),
    ).toBeDefined();
    expect(resolver?.("another", "notes")).toBeUndefined();
  });

  it.each([
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2020-12/schema",
  ])("supports local references in %s and repeated schema ids", ($schema) => {
    for (const type of ["string", "number"]) {
      const document = {
        $schema,
        $id: "https://example.test/reused",
        $defs: { value: { type } },
        $ref: "#/$defs/value",
      };
      const target = { ...policy, schema: document };
      expect(
        datasetFailure("write", target, ["set"], {
          value: type === "string" ? "ok" : 1,
        }),
      ).toBeUndefined();
      expect(
        datasetFailure("write", target, ["set"], { value: null })?.code,
      ).toBe("dataset-violation");
    }
  });

  it("reports at most three schema errors without including the record body", () => {
    const failure = datasetFailure(
      "write",
      { ...policy, schema: { type: "object", required: ["a", "b", "c", "d"] } },
      ["set"],
      { value: { private: "secret-record-body" } },
    );
    expect(failure?.error).not.toContain("secret-record-body");
    expect(failure?.error).toContain("'c'");
    expect(failure?.error).not.toContain("'d'");
  });
});
