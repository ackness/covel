import { describe, it, expect } from "vitest";
import {
  registerImageWire,
  getImageWire,
  DEFAULT_IMAGE_WIRE,
} from "../src/image/wire-registry.js";
import type { ImageWire } from "../src/image/types.js";

describe("image wire registry", () => {
  it("has builtin wires registered", () => {
    expect(getImageWire("openai-images")).not.toBeNull();
    expect(getImageWire("dashscope-wan")).not.toBeNull();
    expect(DEFAULT_IMAGE_WIRE).toBe("openai-images");
  });

  it("returns null for unknown wire", () => {
    expect(getImageWire("nope")).toBeNull();
  });

  it("registers a custom wire and rejects duplicate ids", () => {
    const wire: ImageWire = {
      id: "test-wire",
      generate: async () => ({ images: [], usage: null, warnings: [] }),
    };
    registerImageWire(wire);
    expect(getImageWire("test-wire")).toBe(wire);
    expect(() => registerImageWire(wire)).toThrow(/already registered/);
  });
});
