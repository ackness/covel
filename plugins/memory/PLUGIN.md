---
name: memory
description:
  zh: 展示故事记住的重点，包括剧情、场景、人物关系和主角状态。
  en: Shows what the story remembers, including plot, scene, relationships, and hero status.
pluginType: core-plugin
outputKind: system
capabilities:
  - memory-panel
tags:
  - role:memory
  - cost:ui-only
  - ui:right-panel
trigger:
  type: manual
ui:
  right:
    - ./ui/memory-panel.json
relations: {}
memoryBlocks:
  - label: story_state
    displayName: { zh: 剧情状态, en: Story State }
    icon: BookOpen
    extractionHint:
      zh: 主线剧情摘要、已揭示的秘密、未解决的悬念、已完成的关键事件。
      en: Main plot summary, revealed secrets, unresolved threads, key completed events.
  - label: character_relationships
    displayName: { zh: 角色关系, en: Character Relationships }
    icon: Users
    extractionHint:
      zh: 主角（玩家）与关键角色之间的羁绊：好感、信任、压力、承诺与态度变化，以及对玩家的重要互动。只记录与玩家相关的关系；NPC 之间的结构性关系由关系图谱（npc-graph）负责，不在此重复。
      en: The player character's bonds with key characters — affection, trust, pressure, promises, attitude shifts, and interactions toward the player. Track only player-centric bonds; NPC↔NPC structural relationships are owned by the relationship graph (npc-graph) and are not duplicated here.
  - label: scene
    displayName: { zh: 当前场景, en: Current Scene }
    icon: MapPin
    extractionHint:
      zh: 当前所在位置、时间、氛围与环境描写要点。
      en: Current location, time, atmosphere, and salient environmental details.
  - label: player_profile
    displayName: { zh: 玩家状态, en: Player Profile }
    icon: User
    extractionHint:
      zh: 玩家角色的当前状态摘要：能力、所持之物、处境与当前目标。
      en: "Player character status summary: abilities, possessions, situation, and current objectives."
---

纯 UI 插件。本插件声明右侧记忆面板，并通过 `memoryBlocks` 声明默认的四个通用记忆块（剧情状态 / 角色关系 / 当前场景 / 玩家状态）及其抽取提示词。核心记忆的读写由框架 Memory System（@covel/memory）在每轮结束后按这些块定义自动完成。任意插件或世界包都可以声明自己的 `memoryBlocks`（如 `clues` / `suspects` / `timeline`），框架会聚合后驱动抽取与渲染，无需改动框架核心。
