import { PLUGIN_IDS, type PluginId, type Visual } from "./copy.js";

// Which plugins the hero lights up for each way to play. The sets are
// copied from the packs that ship in the repository (requested and
// recommended), minus the setup plugins every session runs (pregame,
// world-init, char-creator):
// - stage: worlds/haruka-academy/world.yaml `haruka-galgame`
// - tabletop: worlds/lantern-barrow/world.yaml `classic-tabletop`
// - story: packs/builtin.yaml `traditional-story`

export const PACKS: Record<Visual, readonly PluginId[]> = {
  stage: [
    "chat-mode-narrator",
    "scene-stage",
    "guide",
    "character-blueprint",
    "living-world-rules",
    "branch-reply",
    "affinity",
    "story-events",
    "npc-graph",
  ],
  tabletop: [
    "narrator",
    "tabletop-rules",
    "dice-check",
    "core-quest",
    "inventory",
    "affinity",
    "guide",
    "codex",
    "npc-graph",
    "living-world-rules",
    "character-blueprint",
    "story-events",
    "branch-reply",
  ],
  story: [
    "narrator",
    "guide",
    "codex",
    "npc-graph",
    "living-world-rules",
    "memory",
  ],
  // Language support is not a plugin: every one of them reads the session
  // locale.
  languages: PLUGIN_IDS,
};
