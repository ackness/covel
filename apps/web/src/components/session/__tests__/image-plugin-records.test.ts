import { describe, expect, it } from "vitest";
import {
  findImagesByPrompt,
  getImageRef,
  getJobPromptContext,
  isImageRecord,
  parseImageRows,
} from "../image-plugin-panels/image-records.js";
import type { PluginJobRecord } from "@/stores/plugin-data-store.js";

const ref = {
  id: "a".repeat(64),
  mime: "image/png",
  size: 123,
};

describe("image plugin record helpers", () => {
  it("recognizes image records by image id, media ref, or image key", () => {
    expect(isImageRecord("record", { imageId: "img-1" })).toBe(true);
    expect(isImageRecord("record", { ref })).toBe(true);
    expect(isImageRecord("img-fallback", {})).toBe(true);
    expect(isImageRecord("record", { prompt: "only text" })).toBe(false);
  });

  it("sorts image rows newest first", () => {
    expect(
      parseImageRows({
        old: { imageId: "old", startedAt: "2026-01-01T00:00:00Z" },
        nope: { prompt: "not an image" },
        fresh: { imageId: "fresh", startedAt: "2026-01-02T00:00:00Z" },
      }).map((row) => row.key),
    ).toEqual(["fresh", "old"]);
  });

  it("extracts valid media refs and prompt-linked rows", () => {
    const rows = parseImageRows({
      one: { imageId: "one", prompt: "draw a moon", ref },
      two: { imageId: "two", prompt: "draw a sun" },
    });

    expect(getImageRef(rows[0]!.value)).toEqual(ref);
    expect(
      findImagesByPrompt(rows, "draw a moon").map((row) => row.key),
    ).toEqual(["one"]);
    expect(findImagesByPrompt(rows, "")).toEqual([]);
  });

  it("prefers trigger event prompt fields over runtime output fallbacks", () => {
    const job = {
      jobId: "job-1",
      status: "done",
      triggerEvent: {
        data: {
          prompt: "trigger prompt",
          promptMode: "image",
          composition: "portrait",
        },
      },
      runtimeResults: [
        {
          runtimeId: "rt",
          pluginId: "plugin",
          status: "success",
          durationMs: 10,
          output: {
            prompt: "output prompt",
            promptMode: "text",
            composition: "single-scene",
          },
        },
      ],
    } as PluginJobRecord;

    expect(getJobPromptContext(job)).toEqual({
      prompt: "trigger prompt",
      promptMode: "image",
      composition: "portrait",
    });
  });

  it("falls back to runtime output and defaults missing prompt options", () => {
    const job = {
      jobId: "job-1",
      status: "done",
      runtimeResults: [
        {
          runtimeId: "rt",
          pluginId: "plugin",
          status: "success",
          durationMs: 10,
          output: {
            prompt: "output prompt",
          },
        },
      ],
    } as PluginJobRecord;

    expect(getJobPromptContext(job)).toEqual({
      prompt: "output prompt",
      promptMode: "text",
      composition: "single-scene",
    });
  });
});
