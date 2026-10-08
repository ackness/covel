import type { WorldRecord } from "@/services/api.js";

export interface WorldVisual {
  image: string;
  accent: string;
  label: string;
}

const DEFAULT_VISUAL: WorldVisual = {
  image: "/visuals/backgrounds/studio-shell.webp",
  accent: "var(--accent-primary)",
  label: "Covel Studio",
};

const BUNDLED_VISUALS = {
  "lantern-barrow": {
    image: "/visuals/worlds/lantern-barrow.webp",
    accent: "oklch(72% 0.12 75)",
    label: "Lantern Barrow",
  },
  cloudmere: {
    image: "/visuals/worlds/cloudmere.webp",
    accent: "oklch(72% 0.16 75)",
    label: "Cloudmere",
  },
  emberback: {
    image: "/visuals/worlds/emberback.webp",
    accent: "oklch(72% 0.14 50)",
    label: "Emberback",
  },
  "haruka-academy": {
    image: "/visuals/worlds/haruka-academy.webp",
    accent: "oklch(72% 0.15 350)",
    label: "Haruka Academy",
  },
  mistport: {
    image: "/visuals/worlds/mistport.webp",
    accent: "oklch(72% 0.1 185)",
    label: "Mistport",
  },
  neonridge: {
    image: "/visuals/worlds/neonridge.webp",
    accent: "oklch(72% 0.16 220)",
    label: "Neon Ridge",
  },
} satisfies Record<string, WorldVisual>;

const VISUALS_BY_ID: Record<string, WorldVisual> = BUNDLED_VISUALS;

const VISUALS_BY_TAG: Record<string, WorldVisual> = {
  adventure: BUNDLED_VISUALS.cloudmere,
  cyberpunk: BUNDLED_VISUALS.neonridge,
  "dark-fantasy": BUNDLED_VISUALS.mistport,
  exploration: BUNDLED_VISUALS.mistport,
  hacker: BUNDLED_VISUALS.neonridge,
  mystery: BUNDLED_VISUALS.mistport,
  noir: BUNDLED_VISUALS.neonridge,
  romance: BUNDLED_VISUALS["haruka-academy"],
  school: BUNDLED_VISUALS["haruka-academy"],
  "slice-of-life": BUNDLED_VISUALS["haruka-academy"],
  thriller: BUNDLED_VISUALS.neonridge,
  xianxia: BUNDLED_VISUALS.cloudmere,
};

export function worldVisualForId(id: string | undefined): WorldVisual | null {
  return id ? (VISUALS_BY_ID[id] ?? null) : null;
}

export function worldVisualForTags(
  tags: readonly string[] | undefined,
): WorldVisual | null {
  if (!tags) return null;
  for (const tag of tags) {
    const visual = VISUALS_BY_TAG[tag];
    if (visual) return visual;
  }
  return null;
}

export function worldVisual(
  world: WorldRecord | null | undefined,
): WorldVisual {
  return (
    worldVisualForId(world?.id) ??
    worldVisualForTags(world?.tags) ??
    DEFAULT_VISUAL
  );
}
