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
          config: { a: 1 },
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
      config: { a: 1 },
      userSettings: { theme: "dark" },
      llmContent: "base",
      mockPresetId: "case-slot",
      ignoreUpstreams: false,
      expectsBackgroundFollower: true,
      mediaStore,
    });
  });
});
