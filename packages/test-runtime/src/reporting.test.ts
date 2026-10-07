import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import { describe, expect, it } from "vitest";
import type { RuntimeResult } from "@covel/shared";

import {
  evaluateExpectations,
  isExpectedRuntimeFailure,
  listPluginDataByNamespace,
  saveImageArtifacts,
} from "./reporting.js";

function runtimeResult(patch: Partial<RuntimeResult> = {}): RuntimeResult {
  return {
    runtimeId: "plugin/main",
    pluginId: "plugin",
    runId: "run-1",
    turnId: "turn-1",
    status: "success",
    durationMs: 1,
    output: {},
    effects: {
      events: [{ topic: "asset.ready" }],
      assetGenerations: [{ modality: "image", ref: "media-1" }],
    },
    toolCalls: [],
    timestamp: "2026-05-09T00:00:00.000Z",
    ...patch,
  };
}

describe("reporting helpers", () => {
  it.each(["constructor", "toString", "__proto__"])(
    "reports prototype-named namespace %s from real store rows",
    async (namespace) => {
      const store = createMemoryStore();
      await store.createSession({
        id: "test-session",
        locale: "en",
        status: "active",
        phase: "playing",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        activePlugins: ["probe"],
        createdAt: "2026-10-07T00:00:00Z",
        updatedAt: "2026-10-07T00:00:00Z",
      });
      await store.setPluginData({
        id: `row-${namespace}`,
        createdAt: "2026-10-07T00:00:00Z",
        sessionId: "test-session",
        pluginId: "probe",
        namespace,
        key: "latest",
        value: { status: "done", ref: "media-ref" },
        updatedAt: "2026-10-07T00:00:00Z",
      });
      const pluginData = await listPluginDataByNamespace(
        store,
        "test-session",
        "probe",
      );
      expect(Object.hasOwn(pluginData, namespace)).toBe(true);
      expect(
        evaluateExpectations(
          { pluginData: [{ namespace, key: "latest", field: "ref" }] },
          {
            runtimeId: "probe/main",
            runtimeResults: [],
            pluginData,
            logs: [],
          },
        ),
      ).toEqual([{ status: "passed", message: `pluginData:${namespace}` }]);
    },
  );

  it.each(["constructor", "toString", "__proto__"])(
    "treats absent prototype-named namespace %s as missing in expectations and artifacts",
    async (namespace) => {
      const result = {
        runtimeId: "probe/main",
        runtimeResults: [],
        pluginData: {},
        logs: [],
      };
      expect(
        evaluateExpectations({ pluginData: [{ namespace }] }, result),
      ).toEqual([{ status: "failed", message: `pluginData:${namespace}` }]);
      const pluginRoot = await mkdtemp(
        path.join(os.tmpdir(), "covel-reporting-"),
      );
      try {
        await expect(
          saveImageArtifacts({
            result,
            pluginRoot,
            config: { saveImages: { namespace } },
          }),
        ).resolves.toEqual([]);
      } finally {
        await rm(pluginRoot, { recursive: true, force: true });
      }
    },
  );

  it("keeps every image when different row keys sanitize to the same file name", async () => {
    const mediaStore = createMemoryMediaStore();
    const images = await Promise.all(
      ["one", "two", "three"].map((bytes) =>
        mediaStore.put(Buffer.from(bytes), "image/png"),
      ),
    );
    const pluginRoot = await mkdtemp(
      path.join(os.tmpdir(), "covel-image-artifacts-"),
    );
    try {
      const artifacts = await saveImageArtifacts({
        result: {
          runtimeId: "probe/main",
          runtimeResults: [],
          logs: [],
          pluginData: {
            images: ["a/b", "a?b", "a-b.1"].map((key, i) => ({
              key,
              value: { ref: images[i] },
            })),
          },
        },
        pluginRoot,
        mediaStore,
        config: { saveImages: {} },
      });
      expect(new Set(artifacts.map(({ path }) => path)).size).toBe(3);
      expect(
        await Promise.all(artifacts.map(({ path }) => readFile(path, "utf8"))),
      ).toEqual(["one", "two", "three"]);
    } finally {
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it("does not pass field expectations because a row or asset inherits constructor", () => {
    const assertions = evaluateExpectations(
      {
        pluginData: [{ namespace: "items", field: "constructor" }],
        assetGenerations: [{ modality: "image", field: "constructor" }],
      },
      {
        runtimeId: "probe/main",
        runtimeResults: [
          runtimeResult({
            effects: { assetGenerations: [{ modality: "image" }] },
          }),
        ],
        pluginData: { items: [{ key: "one", value: {} }] },
        logs: [],
      },
    );
    expect(assertions.map(({ status }) => status)).toEqual([
      "failed",
      "failed",
    ]);
  });

  it("evaluates runtime, event, log, plugin data, and asset expectations", () => {
    const assertions = evaluateExpectations(
      {
        runtimeResults: [{ runtimeId: "plugin/main", status: "success" }],
        events: ["asset.ready"],
        logs: ["rendered"],
        pluginData: [
          { namespace: "images", key: "latest", status: "done", field: "ref" },
        ],
        assetGenerations: [{ modality: "image", field: "ref" }],
      },
      {
        runtimeId: "plugin/main",
        runtimeResults: [runtimeResult()],
        pluginData: {
          images: [
            { key: "latest", value: { status: "done", ref: "media-1" } },
          ],
        },
        logs: [{ key: "1", value: { message: "rendered" } }],
      },
    );

    expect(assertions).toEqual([
      { status: "passed", message: "runtime:plugin/main:success" },
      { status: "passed", message: "event:asset.ready" },
      { status: "passed", message: "log:rendered" },
      { status: "passed", message: "pluginData:images" },
      { status: "passed", message: "assetGenerations:image" },
    ]);
  });

  it("does not count business output fields as emitted effects", () => {
    const assertions = evaluateExpectations(
      {
        events: ["asset.ready"],
        assetGenerations: [{ modality: "image" }],
      },
      {
        runtimeId: "plugin/main",
        runtimeResults: [
          runtimeResult({
            effects: undefined,
            output: {
              events: [{ topic: "asset.ready" }],
              assetGenerations: [{ modality: "image", ref: "media-1" }],
            },
          }),
        ],
        pluginData: {},
        logs: [],
      },
    );

    expect(assertions).toEqual([
      { status: "failed", message: "event:asset.ready" },
      { status: "failed", message: "assetGenerations:image" },
    ]);
  });

  it("matches expected runtime failures by runtime and error text", () => {
    const failed = runtimeResult({
      status: "failed",
      error: "provider rejected image prompt",
    });

    expect(
      isExpectedRuntimeFailure(failed, {
        runtimeResults: [
          {
            runtimeId: "plugin/main",
            status: "failed",
            errorIncludes: "image prompt",
          },
        ],
      }),
    ).toBe(true);
    expect(
      isExpectedRuntimeFailure(failed, {
        runtimeResults: [
          {
            runtimeId: "plugin/other",
            status: "failed",
            errorIncludes: "image prompt",
          },
        ],
      }),
    ).toBe(false);
  });
});
