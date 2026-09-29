import type { ImageWire } from "./types.js";
import { openAiImagesWire } from "./openai-images-wire.js";
import { dashscopeWanWire } from "./dashscope-wan-wire.js";

export const DEFAULT_IMAGE_WIRE = "openai-images";

import { registerWire, getWire } from "../wire-lifecycle.js";
export function registerImageWire(wire: ImageWire): () => void {
  return registerWire("image", wire);
}
export function getImageWire(id: string): ImageWire | null {
  return getWire("image", id);
}

registerImageWire(openAiImagesWire);
registerImageWire(dashscopeWanWire);
