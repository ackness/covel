import type { ImageWire } from "./types.js";
import { openAiImagesWire } from "./openai-images-wire.js";
import { dashscopeWanWire } from "./dashscope-wan-wire.js";

export const DEFAULT_IMAGE_WIRE = "openai-images";

// Deliberate runtime Map (unlike the folded protocol registry): plugin
// registration is a designed extension point, not speculative flexibility.
const wires = new Map<string, ImageWire>();

export function registerImageWire(wire: ImageWire): void {
  if (wires.has(wire.id)) {
    throw new Error(`image wire "${wire.id}" already registered`);
  }
  wires.set(wire.id, wire);
}

export function getImageWire(id: string): ImageWire | null {
  return wires.get(id) ?? null;
}

registerImageWire(openAiImagesWire);
registerImageWire(dashscopeWanWire);
