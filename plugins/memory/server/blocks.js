export const DEFAULT_CORE_MEMORY_BLOCKS = [
  {
    label: "story_state",
    displayName: { zh: "剧情状态", en: "Story State" },
    icon: "BookOpen",
    extractionHint: {
      zh: "主线剧情摘要、已揭示的秘密、未解决的悬念、已完成的关键事件。",
      en: "Main plot summary, revealed secrets, unresolved threads, key completed events.",
    },
  },
  {
    label: "character_relationships",
    displayName: { zh: "角色关系", en: "Character Relationships" },
    icon: "Users",
    // Player-centric by design: this block tracks the player's bonds with
    // NPCs. NPC↔NPC structural relationships are owned by the `npc-graph`
    // plugin's typed graph — the two are complementary, not redundant, so the
    // hint explicitly scopes to player-centric bonds to avoid double-extraction.
    extractionHint: {
      zh: "主角（玩家）与关键角色之间的羁绊：好感、信任、压力、承诺与态度变化，以及对玩家的重要互动。只记录与玩家相关的关系；NPC 之间的结构性关系由关系图谱（npc-graph）负责，不在此重复。",
      en: "The player character's bonds with key characters — affection, trust, pressure, promises, attitude shifts, and interactions toward the player. Track only player-centric bonds; NPC↔NPC structural relationships are owned by the relationship graph (npc-graph) and are not duplicated here.",
    },
  },
  {
    label: "scene",
    displayName: { zh: "当前场景", en: "Current Scene" },
    icon: "MapPin",
    extractionHint: {
      zh: "当前所在位置、氛围与环境描写要点。可记录晨昏氛围，不维护当前日期或时刻；以世界时间插件的结构化状态为准。",
      en: "Current location, atmosphere, and salient environmental details. Record ambient light, not an authoritative date or clock; structured world time owns those values.",
    },
  },
  {
    label: "player_profile",
    displayName: { zh: "玩家状态", en: "Player Profile" },
    icon: "User",
    extractionHint: {
      zh: "玩家角色的当前状态摘要：能力、所持之物、处境与当前目标。",
      en: "Player character status summary: abilities, possessions, situation, and current objectives.",
    },
  },
];
