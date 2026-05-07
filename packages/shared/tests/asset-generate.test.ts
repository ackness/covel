import { describe, expect, it } from "vitest";
import {
  assetGenerateToLLM,
  assetGenerateToView,
  isAssetGeneratePayload,
  isAssetGenerateView,
} from "../src/index.js";
import type { Proposal } from "../src/index.js";

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
    payload,
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

  it("returns LLM content parts for generated image assets", () => {
    const llm = assetGenerateToLLM(
      makeProposal({ ref: REF, modality: "image" }),
    );

    expect(llm).toEqual([
      {
        type: "text",
        text: `Generated image asset id=${REF.id} mime=${REF.mime} size=${REF.size}`,
      },
      { type: "image", image: REF },
    ]);
  });
});
