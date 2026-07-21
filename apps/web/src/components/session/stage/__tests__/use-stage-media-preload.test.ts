import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { MediaRef } from "@covel/shared";
import {
  __clearAllPluginDataForTest,
  loadPluginData,
  setActiveSession,
} from "@/stores/plugin-data-store.js";
import { useStageMediaPreload } from "../use-stage-media-preload.js";

vi.mock("@/lib/media-resolve.js", () => ({
  resolveMediaSrc: vi.fn(async () => ({
    url: "data:image/png;base64,",
    fromCache: false,
    ok: true,
  })),
}));
vi.mock("@/services/api/plugin-data.js", () => ({
  listPluginData: vi.fn(async () => [
    {
      namespace: "scenes",
      key: "scene-registry",
      value: {
        scenes: [
          { sceneId: "sc1", name: "Gate", day: ref("d".repeat(64)) },
          {
            sceneId: "sc2",
            name: "Hall",
            day: ref("e".repeat(64)),
            night: null,
          },
        ],
      },
      updatedAt: "",
    },
  ]),
}));

import { resolveMediaSrc } from "@/lib/media-resolve.js";

function ref(id: string, mime = "image/png"): MediaRef {
  return { id, mime, size: 1 } as MediaRef;
}

const PLUGINS = [
  {
    id: "character-presence",
    isActive: true,
    capabilities: ["character-presence"],
  },
  { id: "scene-stage", isActive: true, capabilities: ["scene-stage"] },
];

describe("useStageMediaPreload", () => {
  beforeEach(() => {
    setActiveSession("s1");
    loadPluginData("character-presence", "presence", [
      {
        key: "hero",
        value: {
          characterId: "hero",
          sprite: ref("a".repeat(64)),
          avatar: ref("b".repeat(64)),
          voice: ref("c".repeat(64), "audio/wav"),
        },
      },
    ]);
  });

  afterEach(() => {
    __clearAllPluginDataForTest();
    vi.clearAllMocks();
  });

  it("warms presence sprites/avatars and scene registry backdrops, images only", async () => {
    renderHook(() => useStageMediaPreload("s1", PLUGINS));

    await waitFor(() => {
      const warmedIds = vi
        .mocked(resolveMediaSrc)
        .mock.calls.map(([r]) => r.id)
        .sort();
      expect(warmedIds).toEqual([
        "a".repeat(64),
        "b".repeat(64),
        "d".repeat(64),
        "e".repeat(64),
      ]);
    });
  });

  it("skips everything when no capability provider is active", async () => {
    renderHook(() =>
      useStageMediaPreload("s1", [
        { id: "narrator", isActive: true, capabilities: ["narrative"] },
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveMediaSrc).not.toHaveBeenCalled();
  });
});
