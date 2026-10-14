import type { MusicWire } from "./types.js";
import { registerWire, getWire, type WireOwner } from "../wire-lifecycle.js";

// No built-in wire and no default: music providers share no request format,
// so a slot names its wire (`providerRequestMetadata.musicWire`) or fails.
// With `owner`, the wire serves only sessions in which that plugin is active.
export function registerMusicWire(
  wire: MusicWire,
  owner?: WireOwner,
): () => void {
  return registerWire("music", wire, owner);
}
export function getMusicWire(id: string): MusicWire | null {
  return getWire("music", id);
}
