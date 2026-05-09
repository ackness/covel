import fs from "node:fs";
import path from "node:path";
import type { RuntimeResult } from "@covel/shared";
import type { DataStore, MediaStore } from "@covel/store";

export interface CaseExpectations {
  readonly runtimeResults?: readonly {
    readonly runtimeId?: string;
    readonly status: RuntimeResult["status"];
    readonly errorIncludes?: string;
  }[];
  readonly events?: readonly string[];
  readonly logs?: readonly string[];
  readonly pluginData?: readonly {
    readonly namespace: string;
    readonly key?: string;
    readonly status?: string;
    readonly field?: string;
  }[];
  readonly assetGenerations?: readonly {
    readonly modality?: string;
    readonly field?: string;
  }[];
}

export interface CaseAssertion {
  readonly status: "passed" | "failed";
  readonly message: string;
}

export interface CaseArtifactConfig {
  readonly saveImages?: {
    readonly namespace?: string;
    readonly dir?: string;
    readonly field?: string;
  };
}

export interface CaseArtifact {
  readonly type: "image";
  readonly namespace: string;
  readonly key: string;
  readonly path: string;
  readonly source: "media";
  readonly mimeType?: string;
}

type PluginDataReport = Readonly<
  Record<
    string,
    ReadonlyArray<{ readonly key: string; readonly value: unknown }>
  >
>;

interface RuntimeReportResult {
  readonly runtimeId: string;
  readonly caseName?: string;
  readonly runtimeResults: readonly RuntimeResult[];
  readonly pluginData: PluginDataReport;
  readonly logs: ReadonlyArray<{
    readonly key: string;
    readonly value: unknown;
  }>;
}

export async function listPluginDataByNamespace(
  store: DataStore,
  sessionId: string,
  pluginId: string,
): Promise<Record<string, Array<{ key: string; value: unknown }>>> {
  const rows = await store.listPluginData(sessionId, pluginId);
  const out: Record<string, Array<{ key: string; value: unknown }>> = {};
  for (const row of rows) {
    const list = out[row.namespace] ?? [];
    list.push({ key: row.key, value: row.value });
    out[row.namespace] = list;
  }
  return out;
}

export function evaluateExpectations(
  expect: CaseExpectations | undefined,
  result: RuntimeReportResult,
): readonly CaseAssertion[] {
  if (!expect) return [];
  const assertions: CaseAssertion[] = [];
  for (const expected of expect.runtimeResults ?? []) {
    const matched = result.runtimeResults.some((runtimeResult) => {
      if (expected.runtimeId && runtimeResult.runtimeId !== expected.runtimeId)
        return false;
      if (runtimeResult.status !== expected.status) return false;
      if (expected.errorIncludes) {
        return (
          typeof runtimeResult.error === "string" &&
          runtimeResult.error.includes(expected.errorIncludes)
        );
      }
      return true;
    });
    assertions.push({
      status: matched ? "passed" : "failed",
      message: `runtime:${expected.runtimeId ?? "*"}:${expected.status}`,
    });
  }
  const eventTopics = collectEventTopics(result.runtimeResults);
  for (const topic of expect.events ?? []) {
    assertions.push({
      status: eventTopics.has(topic) ? "passed" : "failed",
      message: `event:${topic}`,
    });
  }
  const logMessages = new Set(
    result.logs
      .map((row) => row.value)
      .filter(
        (value): value is { message?: unknown } =>
          Boolean(value) && typeof value === "object",
      )
      .map((value) => value.message)
      .filter((value): value is string => typeof value === "string"),
  );
  for (const message of expect.logs ?? []) {
    assertions.push({
      status: logMessages.has(message) ? "passed" : "failed",
      message: `log:${message}`,
    });
  }
  for (const expected of expect.pluginData ?? []) {
    const rows = result.pluginData[expected.namespace] ?? [];
    const matched = rows.some((row) => {
      if (expected.key && row.key !== expected.key) return false;
      const value = row.value;
      if (!value || typeof value !== "object") return false;
      const record = value as Record<string, unknown>;
      if (expected.status && record.status !== expected.status) return false;
      if (expected.field && !(expected.field in record)) return false;
      return true;
    });
    assertions.push({
      status: matched ? "passed" : "failed",
      message: `pluginData:${expected.namespace}`,
    });
  }
  for (const expected of expect.assetGenerations ?? []) {
    const matched = collectAssetGenerations(result.runtimeResults).some(
      (asset) => {
        if (expected.modality && asset.modality !== expected.modality)
          return false;
        if (expected.field && !(expected.field in asset)) return false;
        return true;
      },
    );
    assertions.push({
      status: matched ? "passed" : "failed",
      message: `assetGenerations:${expected.modality ?? "*"}`,
    });
  }
  return assertions;
}

export function isExpectedRuntimeFailure(
  runtimeResult: RuntimeResult,
  expect: CaseExpectations | undefined,
): boolean {
  if (runtimeResult.status !== "failed") return false;
  return (expect?.runtimeResults ?? []).some((expected) => {
    if (expected.status !== "failed") return false;
    if (expected.runtimeId && expected.runtimeId !== runtimeResult.runtimeId)
      return false;
    if (expected.errorIncludes) {
      return (
        typeof runtimeResult.error === "string" &&
        runtimeResult.error.includes(expected.errorIncludes)
      );
    }
    return true;
  });
}

export async function saveImageArtifacts(args: {
  readonly result: RuntimeReportResult;
  readonly pluginRoot: string;
  readonly config: CaseArtifactConfig | undefined;
  readonly mediaStore?: MediaStore;
}): Promise<readonly CaseArtifact[]> {
  const saveImages = args.config?.saveImages;
  if (!saveImages) return [];
  const namespace = saveImages.namespace ?? "images";
  const field = saveImages.field ?? "ref";
  const rows = args.result.pluginData[namespace] ?? [];
  const outDir = path.resolve(args.pluginRoot, saveImages.dir ?? "tests/tmp");
  fs.mkdirSync(outDir, { recursive: true });

  const artifacts: CaseArtifact[] = [];
  for (const row of rows) {
    const value = row.value;
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const maybeRef = record[field];
    const refMime = isMediaRef(maybeRef) ? maybeRef.mime : undefined;
    const mimeType =
      refMime ??
      (typeof record.mimeType === "string" ? record.mimeType : undefined);
    const ext = extensionFromMime(mimeType);
    const fileName = `${safeFilePart(args.result.caseName ?? args.result.runtimeId)}-${safeFilePart(row.key)}${ext}`;
    const filePath = path.join(outDir, fileName);

    if (isMediaRef(maybeRef) && args.mediaStore) {
      const bytes = await args.mediaStore.get(maybeRef);
      const buffer =
        bytes instanceof Blob
          ? Buffer.from(await bytes.arrayBuffer())
          : Buffer.from(bytes);
      fs.writeFileSync(filePath, buffer);
      artifacts.push({
        type: "image",
        namespace,
        key: row.key,
        path: filePath,
        source: "media",
        mimeType: maybeRef.mime,
      });
    }
  }
  return artifacts;
}

function collectEventTopics(
  runtimeResults: readonly RuntimeResult[],
): Set<string> {
  const topics = new Set<string>();
  for (const result of runtimeResults) {
    const output = result.output;
    if (!output || typeof output !== "object") continue;
    const events = (output as { events?: unknown }).events;
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const topic = (event as { topic?: unknown }).topic;
      if (typeof topic === "string") topics.add(topic);
    }
  }
  return topics;
}

function collectAssetGenerations(
  runtimeResults: readonly RuntimeResult[],
): ReadonlyArray<Record<string, unknown>> {
  const assets: Record<string, unknown>[] = [];
  for (const runtimeResult of runtimeResults) {
    const output = runtimeResult.output;
    if (!output || typeof output !== "object") continue;
    const assetGenerations = (output as Record<string, unknown>)
      .assetGenerations;
    if (!Array.isArray(assetGenerations)) continue;
    for (const asset of assetGenerations) {
      if (asset && typeof asset === "object") {
        assets.push(asset as Record<string, unknown>);
      }
    }
  }
  return assets;
}

function extensionFromMime(mimeType: unknown): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/png") return ".png";
  return ".png";
}

function safeFilePart(input: string): string {
  return (
    input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "artifact"
  );
}

function isMediaRef(
  value: unknown,
): value is { id: string; mime: string; size: number } {
  if (!value || typeof value !== "object") return false;
  const ref = value as { id?: unknown; mime?: unknown; size?: unknown };
  return (
    typeof ref.id === "string" &&
    typeof ref.mime === "string" &&
    typeof ref.size === "number"
  );
}
