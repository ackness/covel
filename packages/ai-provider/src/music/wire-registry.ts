import type { MusicWire } from "./types.js";
import { registerWire, getWire } from "../wire-lifecycle.js";

// No built-in wire and no default: music providers share no request format,
// so a slot names its wire (`providerRequestMetadata.musicWire`) or fails.
export function registerMusicWire(wire: MusicWire): () => void {
  return registerWire("music", wire);
}
export function getMusicWire(id: string): MusicWire | null {
  return getWire("music", id);
}
