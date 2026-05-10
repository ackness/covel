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

const VISUALS_BY_ID: Record<string, WorldVisual> = {
  cloudmere: {
    image: "/visuals/worlds/cloudmere.webp",
    accent: "oklch(72% 0.16 75)",
    label: "Cloudmere",
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
};

const VISUALS_BY_TAG: Record<string, WorldVisual> = {
  adventure: VISUALS_BY_ID.cloudmere,
  cyberpunk: VISUALS_BY_ID.neonridge,
  "dark-fantasy": VISUALS_BY_ID.mistport,
  exploration: VISUALS_BY_ID.mistport,
  hacker: VISUALS_BY_ID.neonridge,
  mystery: VISUALS_BY_ID.mistport,
  noir: VISUALS_BY_ID.neonridge,
  romance: VISUALS_BY_ID["haruka-academy"],
  school: VISUALS_BY_ID["haruka-academy"],
  "slice-of-life": VISUALS_BY_ID["haruka-academy"],
  thriller: VISUALS_BY_ID.neonridge,
  xianxia: VISUALS_BY_ID.cloudmere,
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
