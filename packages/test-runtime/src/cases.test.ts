import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCaseDebugOptions,
  caseFilesFor,
  filterRuntimeCases,
  parseCaseFile,
} from "./cases.js";

describe("runtime case helpers", () => {
  it("resolves supported case file paths", () => {
    expect(caseFilesFor("/plugin")).toEqual([
      path.join("/plugin", "tests", "runtime-cases.json"),
      path.join("/plugin", "covel.test.json"),
    ]);
  });

  it("parses array and object case files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-cases-"));
    const arrayFile = path.join(dir, "array.json");
    const objectFile = path.join(dir, "object.json");
    fs.writeFileSync(
      arrayFile,
      JSON.stringify([{ name: "array", runtimeId: "plugin/main" }]),
    );
    fs.writeFileSync(
      objectFile,
      JSON.stringify({ cases: [{ name: "object", runtimeId: "plugin/main" }] }),
    );

    expect(parseCaseFile(arrayFile).map((item) => item.name)).toEqual([
      "array",
    ]);
    expect(parseCaseFile(objectFile).map((item) => item.name)).toEqual([
      "object",
    ]);
  });

  it("filters cases by name and mode", () => {
    const cases = [
      { name: "mock", runtimeId: "plugin/mock", mode: "mock" as const },
      { name: "live", runtimeId: "plugin/live", mode: "live" as const },
      { name: "both", runtimeId: "plugin/both" },
    ];

    expect(
      filterRuntimeCases({
        cases,
        caseName: undefined,
        mode: "mock",
        caseFile: "cases.json",
      }).map((item) => item.name),
    ).toEqual(["mock", "both"]);
    expect(() =>
      filterRuntimeCases({
        cases,
        caseName: "missing",
        mode: "mock",
        caseFile: "cases.json",
      }),
    ).toThrow('case "missing" not found or not enabled for mode "mock"');
  });

  it("builds case debug options with case values taking precedence", () => {
    const mediaStore = {} as Parameters<
      typeof buildCaseDebugOptions
    >[0]["mediaStore"];
    expect(
      buildCaseDebugOptions({
        base: {
          pluginId: "base-plugin",
          message: "base message",
          payload: { from: "base" },
          userSettings: { theme: "dark" },
          llmContent: "base",
          mockPresetId: "base-slot",
          ignoreUpstreams: false,
          expectsBackgroundFollower: false,
        },
        testCase: {
          name: "case",
          runtimeId: "case/runtime",
          pluginId: "case-plugin",
          message: "case message",
          mockPresetId: "case-slot",
          expectsBackgroundFollower: true,
        },
        pluginId: "fallback-plugin",
        mediaStore,
      }),
    ).toMatchObject({
      runtimeId: "case/runtime",
      pluginId: "case-plugin",
      caseName: "case",
      message: "case message",
      payload: { from: "base" },
      userSettings: { theme: "dark" },
      llmContent: "base",
      mockPresetId: "case-slot",
      ignoreUpstreams: false,
      expectsBackgroundFollower: true,
      mediaStore,
    });
  });
});

describe("strict runtime case files", () => {
  const valid = { name: "sample", runtimeId: "plugin/main" };
  it.each([
    [{ cases: [{ ...valid, expects: {} }] }, "cases.0"],
    [
      { cases: [{ ...valid, expect: { runtimeResult: [] } }] },
      "cases.0.expect",
    ],
    [{ cases: [{ name: "sample" }] }, "cases.0.runtimeId"],
    [{ cases: [{ runtimeId: "plugin/main" }] }, "cases.0.name"],
    [{ cases: [{ ...valid, name: "" }] }, "cases.0.name"],
    [{ cases: [{ ...valid, mode: "Mock" }] }, "cases.0.mode"],
    [
      { cases: [{ ...valid, ignoreUpstreams: "true" }] },
      "cases.0.ignoreUpstreams",
    ],
    [
      {
        cases: [
          { ...valid, expect: { runtimeResults: [{ status: "sucess" }] } },
        ],
      },
      "cases.0.expect.runtimeResults.0.status",
    ],
    [
      {
        cases: [
          {
            ...valid,
            expect: { pluginData: [{ namespace: "notes", fields: "title" }] },
          },
        ],
      },
      "cases.0.expect.pluginData.0",
    ],
    [
      {
        cases: [{ ...valid, artifacts: { saveImages: { directory: "out" } } }],
      },
      "cases.0.artifacts.saveImages",
    ],
    [{ case: [valid] }, "cases"],
    [{ cases: [] }, "cases"],
    [null, "(root)"],
    [[{ ...valid, expects: {} }], "0"],
  ])(
    "rejects invalid input with its file and field path: %j",
    (input, field) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-invalid-case-"));
      const file = path.join(dir, "runtime-cases.json");
      try {
        fs.writeFileSync(file, JSON.stringify(input));
        expect(() => parseCaseFile(file)).toThrow(file);
        expect(() => parseCaseFile(file)).toThrow(String(field));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("accepts editor metadata and plugin-defined payloads, settings and mock objects", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-valid-case-"));
    const file = path.join(dir, "runtime-cases.json");
    const testCase = {
      ...valid,
      mode: "both",
      payload: { arbitrary: [1, { key: true }] },
      userSettings: { optional: null },
      llmObject: { dynamic: "value" },
      expect: {
        runtimeResults: [{ status: "success" }],
        pluginData: [{ namespace: "notes", field: "title" }],
      },
      artifacts: { saveImages: { dir: "output" } },
    };
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({
          $schema: "https://example.org/schema.json",
          cases: [testCase],
        }),
      );
      expect(parseCaseFile(file)).toEqual([testCase]);
      fs.writeFileSync(file, "{");
      expect(() => parseCaseFile(file)).toThrow(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
