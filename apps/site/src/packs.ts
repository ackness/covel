import { PLUGIN_IDS, type PluginId, type Visual } from "./copy.js";

// Which plugins each step of the feature matrix switches on. The sets are
// copied from the packs that ship in the repository (requested and
// recommended), minus the setup plugins every session runs (pregame,
// world-init, char-creator):
// - world: worlds/emberback/world.yaml `emberback-rescue`
// - stage: worlds/haruka-academy/world.yaml `haruka-galgame`
// - tabletop: worlds/lantern-barrow/world.yaml `classic-tabletop`
// - story: packs/builtin.yaml `traditional-story`

export const PACKS: Record<Visual, readonly PluginId[]> = {
  plugin: PLUGIN_IDS,
  world: [
    "narrator",
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
  languages: PLUGIN_IDS,
};
