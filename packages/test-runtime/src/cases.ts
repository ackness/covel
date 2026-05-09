import fs from "node:fs";
import path from "node:path";
import type { MediaStore } from "@covel/store";

import type { RunRuntimeDebugOptions } from "./runner.js";
import type { CaseArtifactConfig, CaseExpectations } from "./reporting.js";

interface RuntimeCaseFile {
  readonly cases?: readonly RuntimeCase[];
}

export interface RuntimeCase {
  readonly name: string;
  readonly runtimeId: string;
  readonly pluginId?: string;
  readonly message?: string;
  readonly payload?: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
  readonly userSettings?: Record<string, unknown>;
  readonly llmResponse?: Record<string, unknown>;
  readonly llmResponses?: readonly Record<string, unknown>[];
  readonly llmContent?: string;
  readonly llmObject?: Record<string, unknown>;
  readonly mockPresetId?: string;
  readonly ignoreUpstreams?: boolean;
  readonly expectsBackgroundFollower?: boolean;
  readonly mode?: "mock" | "live" | "both";
  readonly expect?: CaseExpectations;
  readonly artifacts?: CaseArtifactConfig;
}

export function caseFilesFor(pluginRoot: string): readonly string[] {
  return [
    path.join(pluginRoot, "tests", "runtime-cases.json"),
    path.join(pluginRoot, "covel.test.json"),
  ];
}

export function parseCaseFile(file: string): readonly RuntimeCase[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (Array.isArray(parsed)) return parsed as readonly RuntimeCase[];
  if (parsed && typeof parsed === "object") {
    return (parsed as RuntimeCaseFile).cases ?? [];
  }
  return [];
}

export function filterRuntimeCases(args: {
  readonly cases: readonly RuntimeCase[];
  readonly caseName?: string;
  readonly mode: "mock" | "live";
  readonly caseFile: string;
}): readonly RuntimeCase[] {
  const filtered = args.cases.filter((item) => {
    if (args.caseName && item.name !== args.caseName) return false;
    const caseMode = item.mode ?? "both";
    return caseMode === "both" || caseMode === args.mode;
  });
  if (filtered.length > 0) return filtered;
  const reason = args.caseName
    ? `case "${args.caseName}" not found or not enabled for mode "${args.mode}"`
    : `no cases enabled for mode "${args.mode}"`;
  throw new Error(`${reason} in ${args.caseFile}`);
}

export function buildCaseDebugOptions(args: {
  readonly base: RunRuntimeDebugOptions;
  readonly testCase: RuntimeCase;
  readonly pluginId: string;
  readonly mediaStore: MediaStore;
}): RunRuntimeDebugOptions {
  const { base, testCase } = args;
  return {
    ...base,
    runtimeId: testCase.runtimeId,
    pluginId: testCase.pluginId ?? args.pluginId,
    caseName: testCase.name,
    message: testCase.message ?? base.message,
    payload: testCase.payload ?? base.payload,
    config: testCase.config ?? base.config,
    userSettings: testCase.userSettings ?? base.userSettings,
    llmResponse: testCase.llmResponse ?? base.llmResponse,
    llmResponses: testCase.llmResponses ?? base.llmResponses,
    llmContent: testCase.llmContent ?? base.llmContent,
    llmObject: testCase.llmObject ?? base.llmObject,
    mockPresetId: testCase.mockPresetId ?? base.mockPresetId,
    ignoreUpstreams: testCase.ignoreUpstreams ?? base.ignoreUpstreams,
    expectsBackgroundFollower:
      testCase.expectsBackgroundFollower ?? base.expectsBackgroundFollower,
    mediaStore: args.mediaStore,
  };
}
