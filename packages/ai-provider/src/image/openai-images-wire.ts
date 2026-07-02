import type { ImageWire } from "./types.js";

export const openAiImagesWire: ImageWire = {
  id: "openai-images",
  async generate() {
    throw new Error("not implemented");
  },
};
