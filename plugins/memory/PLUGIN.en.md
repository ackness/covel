---
name: memory
description:
  zh: 展示故事记住的重点，包括剧情、场景、人物关系和主角状态。
  en: Shows what the story remembers, including plot, scene, relationships, and hero status.
pluginType: core-plugin
outputKind: system
capabilities:
  - memory-panel
trigger:
  type: manual
ui:
  right:
    - ./ui/memory-panel.json
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
      zh: 关键角色与玩家之间的关系状态、态度变化、重要互动与承诺。
      en: Key characters' relationships with the player, attitude shifts, important interactions and commitments.
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

Pure UI plugin. It declares the right-hand memory panel and, via `memoryBlocks`, the four default generic memory blocks (Story State / Character Relationships / Current Scene / Player Profile) with their extraction hints. Core-memory reads and writes are handled automatically by the framework's Memory System (@covel/memory) at the end of every turn, driven by these block definitions. Any plugin or world may declare its own `memoryBlocks` (e.g. `clues` / `suspects` / `timeline`); the framework aggregates them to drive extraction and rendering without touching framework core.
