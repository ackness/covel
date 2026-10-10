/**
 * Gate for Markdown images. The story text and world documents are written by
 * a model or a world author, and an `<img>` makes the browser request its URL
 * at once: that tells the host the player's address and lets a model carry
 * text from the conversation out in a query string. Images the app itself
 * serves load as before; an image on another origin waits for the player.
 */

import { createContext } from "react";

/**
 * The world whose text is on screen. "Always load from this host" is
 * remembered per world, so the Markdown renderer reads the world from here
 * instead of every caller passing it down.
 */
export const ImageScopeContext = createContext<string | undefined>(undefined);

export const ALLOWED_IMAGE_HOSTS_SETTING = "media.allowedImageHosts";

/** World id → hosts the player chose to always load images from. */
export type AllowedImageHosts = Readonly<Record<string, readonly string[]>>;

export type ImageSource =
  | { readonly kind: "local" }
  | { readonly kind: "external"; readonly host: string }
  | { readonly kind: "blocked" };

/**
 * Where an image URL points. Relative URLs, the page's own origin, `data:` and
 * `blob:` (the media store hands out blob URLs) are local. Other http(s)
 * origins, including protocol-relative ones, are external; every other scheme
 * is blocked.
 */
export function classifyImageSrc(
  src: string | undefined,
  pageOrigin: string,
): ImageSource {
  if (!src) return { kind: "blocked" };
  let url: URL;
  try {
    url = new URL(src.trim(), pageOrigin);
  } catch {
    return { kind: "blocked" };
  }
  if (url.protocol === "data:" || url.protocol === "blob:") {
    return { kind: "local" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "blocked" };
  }
  if (url.origin === pageOrigin) return { kind: "local" };
  return { kind: "external", host: url.host.toLowerCase() };
}

export function isHostAllowed(
  allowed: AllowedImageHosts | undefined,
  worldId: string | undefined,
  host: string,
): boolean {
  if (!worldId) return false;
  return allowed?.[worldId]?.includes(host) ?? false;
}

/** The setting value after the player always allows `host` for `worldId`. */
export function allowHost(
  allowed: AllowedImageHosts | undefined,
  worldId: string,
  host: string,
): AllowedImageHosts {
  const current = allowed?.[worldId] ?? [];
  if (current.includes(host)) return allowed ?? {};
  return { ...allowed, [worldId]: [...current, host] };
}
