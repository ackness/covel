import { WORLD_ACCENT_PATTERN } from "@covel/shared";
import type { WorldRecord } from "@/services/api.js";

export interface WorldVisual {
  image: string;
  accent: string;
}

const DEFAULT_IMAGE = "/visuals/backgrounds/studio-shell.webp";

/** `media/<dir>/<file>` of a declared cover, or null when it is not that shape. */
function coverParts(
  declared: unknown,
): { source: string; file: string } | null {
  if (typeof declared !== "string") return null;
  const segments = declared.split("/");
  if (
    segments.length !== 3 ||
    segments[0] !== "media" ||
    segments.some((segment) => !segment || segment.startsWith("."))
  )
    return null;
  return { source: segments[1]!, file: segments[2]! };
}

/** The address of the world's declared cover on the server, if it declares one. */
export function worldCoverRef(
  world: Pick<WorldRecord, "id" | "metadata"> | null | undefined,
): { url: string; source: string; file: string } | null {
  const parts = coverParts(world?.metadata?.cover);
  if (!world || !parts) return null;
  return {
    ...parts,
    url: `/api/worlds/${encodeURIComponent(world.id)}/gallery/${encodeURIComponent(parts.source)}/${encodeURIComponent(parts.file)}`,
  };
}

/** A world that declares no accent gets a stable hue from its ID. */
function accentFromId(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `oklch(72% 0.12 ${hash})`;
}

/** What the world declares, else the app's default picture and a hue from its ID. */
export function worldVisual(
  world: WorldRecord | null | undefined,
): WorldVisual {
  const declared = world?.metadata?.accentColor;
  const accent =
    typeof declared === "string" && WORLD_ACCENT_PATTERN.test(declared)
      ? declared
      : world
        ? accentFromId(world.id)
        : "var(--accent-primary)";
  return {
    image: worldCoverRef(world)?.url ?? DEFAULT_IMAGE,
    accent,
  };
}
