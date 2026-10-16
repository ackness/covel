import { describe, expect, it } from "vitest";
import {
  isUIRenderPartsInstruction,
  normalizeUIRenderInstruction,
  type UIRenderInstruction,
} from "../src/index.js";

describe("ui render parts", () => {
  it("rejects single-block instructions without parts", () => {
    const legacy = { id: "guide", type: "action-guide", topic: "Next move" };
    expect(isUIRenderPartsInstruction(legacy)).toBe(false);
    expect(() =>
      normalizeUIRenderInstruction(legacy as unknown as UIRenderInstruction),
    ).toThrow();
  });

  it("preserves typed parts and derives aggregate status", () => {
    const instruction: UIRenderInstruction = {
      layout: "split",
      parts: [
        { id: "text", type: "text", status: "success", content: "Done" },
        {
          id: "image",
          type: "image",
          status: "pending",
          content: { prompt: "forest" },
        },
      ],
    };

    expect(isUIRenderPartsInstruction(instruction)).toBe(true);
    expect(normalizeUIRenderInstruction(instruction)).toMatchObject({
      layout: "split",
      status: "pending",
      parts: instruction.parts,
    });
  });
});
