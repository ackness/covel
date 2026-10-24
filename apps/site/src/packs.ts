import { type PluginId, type Visual } from "./copy.js";

// Which plugins the hero lights up for each way to play. The sets are
// copied from the world policies and requested preset plugins, plus the default World Dimensions / World Time panels.
// This is a presentation subset, not a complete resolved session registry:
// - stage: worlds/haruka-academy/world.yaml, `dialogue-mode` plus its `plus`
// - tabletop: worlds/lantern-barrow/world.yaml, `traditional-story` plus its `plus`
// - story: worlds/mistport/world.yaml, `traditional-story` plus its `plus`
// - survival: worlds/emberback/world.yaml, `traditional-story` plus its `plus`

export const PACKS: Record<Visual, readonly PluginId[]> = {
  stage: [
    "world-init",
    "world-time",
    "memory",
    "chat-mode-narrator",
    "scene-stage",
    "guide",
    "character-blueprint",
    "living-world-rules",
    "branch-reply",
    "affinity",
    "story-events",
  ],
  tabletop: [
    "memory",
    "world-init",
    "world-time",
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
  ],
  story: [
    "character-blueprint",
    "story-events",
    "world-init",
    "world-time",
    "narrator",
    "guide",
    "codex",
    "npc-graph",
    "living-world-rules",
    "memory",
  ],
  survival: [
    "world-init",
    "world-time",
    "narrator",
    "guide",
    "codex",
    "npc-graph",
    "living-world-rules",
    "memory",
    "dice-check",
    "core-quest",
    "inventory",
    "affinity",
    "character-blueprint",
    "story-events",
  ],
};

export const WORLD_IDS: Record<Visual, string> = {
  stage: "haruka-academy",
  tabletop: "lantern-barrow",
  story: "mistport",
  survival: "emberback",
};

/** Plugins responsible for each moment, in the same order as journey copy. */
export const MOMENT_PLUGINS: Record<Visual, readonly (readonly PluginId[])[]> =
  {
    stage: [
      ["scene-stage", "chat-mode-narrator"],
      ["guide"],
      ["affinity", "world-init"],
    ],
    tabletop: [
      ["tabletop-rules", "dice-check"],
      ["dice-check"],
      ["core-quest", "inventory"],
    ],
    story: [["narrator", "guide"], ["codex", "memory"], ["world-init"]],
    survival: [
      ["narrator", "world-init"],
      ["core-quest", "inventory"],
      ["world-time", "world-init"],
    ],
  };
