import fs from "node:fs";
import path from "node:path";
import type { MediaStore } from "@covel/store";

import type { RunRuntimeDebugOptions } from "./types.js";
import {
  runtimeCaseFileSchema,
  runtimeCasesSchema,
  type RuntimeCase,
} from "@covel/shared";
export type { RuntimeCase } from "@covel/shared";

export function caseFilesFor(pluginRoot: string): readonly string[] {
  return [
    path.join(pluginRoot, "tests", "runtime-cases.json"),
    path.join(pluginRoot, "covel.test.json"),
  ];
}

export function parseCaseFile(file: string): readonly RuntimeCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (cause) {
    throw new Error(
      `${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const result = (
    Array.isArray(parsed) ? runtimeCasesSchema : runtimeCaseFileSchema
  ).safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${file}: ${details}`, { cause: result.error });
  }
  return Array.isArray(result.data) ? result.data : result.data.cases;
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
    withPlugins: testCase.withPlugins ?? base.withPlugins,
    caseName: testCase.name,
    message: testCase.message ?? base.message,
    payload: testCase.payload ?? base.payload,
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
