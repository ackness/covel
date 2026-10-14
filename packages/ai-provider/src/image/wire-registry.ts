import type { ImageWire } from "./types.js";
import { openAiImagesWire } from "./openai-images-wire.js";
import { dashscopeWanWire } from "./dashscope-wan-wire.js";

export const DEFAULT_IMAGE_WIRE = "openai-images";

import { registerWire, getWire, type WireOwner } from "../wire-lifecycle.js";
/** With `owner`, the wire serves only sessions in which that plugin is active. */
export function registerImageWire(
  wire: ImageWire,
  owner?: WireOwner,
): () => void {
  return registerWire("image", wire, owner);
}
export function getImageWire(id: string): ImageWire | null {
  return getWire("image", id);
}

registerImageWire(openAiImagesWire);
registerImageWire(dashscopeWanWire);
