import { describe, expect, it } from "vitest";
import {
  assetGenerateToView,
  isAssetGeneratePayload,
  isAssetGenerateView,
  pictureOf,
  picturesShown,
} from "../src/index.js";
import type { AssetGeneratePayload, Proposal } from "../src/index.js";

const REF = {
  id: "a".repeat(64),
  mime: "image/png",
  size: 1234,
  meta: { width: 512, height: 512 },
};

function makeProposal(payload: Record<string, unknown>): Proposal {
  return {
    id: "proposal-asset-1",
    type: "asset.generate",
    source: { pluginId: "image-plugin", runtimeId: "generate" },
    turnId: "turn-1",
    sessionId: "sess-1",
    // Cases also pass malformed payloads on purpose.
    payload: payload as unknown as AssetGeneratePayload,
    timestamp: "2026-04-26T00:00:00.000Z",
  };
}

describe("asset.generate helpers", () => {
  it("accepts the ref/modality/meta payload envelope", () => {
    expect(
      isAssetGeneratePayload({
        ref: REF,
        modality: "image",
        meta: { prompt: "mountain" },
      }),
    ).toBe(true);
  });

  it("rejects inline media payloads", () => {
    expect(isAssetGeneratePayload({ base64: "abc", modality: "image" })).toBe(
      false,
    );
    expect(isAssetGeneratePayload({ ref: REF, modality: "" })).toBe(false);
  });

  it("derives a view payload for clients", () => {
    const view = assetGenerateToView(
      makeProposal({
        ref: REF,
        modality: "image",
        meta: { prompt: "mountain" },
      }),
    );

    expect(view).toMatchObject({
      id: "proposal-asset-1",
      type: "asset.generate",
      sessionId: "sess-1",
      turnId: "turn-1",
      modality: "image",
      meta: { prompt: "mountain" },
    });
    expect(view.ref).toEqual(REF);
    expect(isAssetGenerateView(view)).toBe(true);
    expect(isAssetGenerateView({ ...view, source: {} })).toBe(false);
  });

  it("describes a picture by its caption, else by the prompt that made it", () => {
    const view = (meta?: Record<string, unknown>, modality = "image") =>
      assetGenerateToView(
        makeProposal({ ref: REF, modality, ...(meta ? { meta } : {}) }),
      );

    expect(pictureOf(view({ prompt: "a  lighthouse\nat dusk" }))).toEqual({
      ref: REF,
      caption: "a lighthouse at dusk",
    });
    expect(
      pictureOf(view({ prompt: "p", caption: "Mira on the pier" }))?.caption,
    ).toBe("Mira on the pier");
    expect(pictureOf(view())).toEqual({ ref: REF });
    // A long image prompt is cut, not carried whole into every prompt.
    expect(pictureOf(view({ prompt: "x".repeat(2000) }))?.caption).toHaveLength(
      601,
    );
    // Sound is no picture.
    expect(
      pictureOf(
        assetGenerateToView(
          makeProposal({
            ref: { ...REF, mime: "audio/wav" },
            modality: "audio",
          }),
        ),
      ),
    ).toBeNull();
  });

  it("finds the pictures among the blocks a conversation row showed", () => {
    const view = assetGenerateToView(
      makeProposal({ ref: REF, modality: "image", meta: { prompt: "a map" } }),
    );
    expect(
      picturesShown([
        { type: "ui.render", data: { parts: [] } },
        { type: "asset.generate", data: view },
        { type: "asset.generate", data: { ...view, ref: { id: "short" } } },
        null,
      ]),
    ).toEqual([{ ref: REF, caption: "a map" }]);
    expect(picturesShown(undefined)).toEqual([]);
  });
});
