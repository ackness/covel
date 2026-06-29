---
name: char-creator
description:
  zh: 帮你创建主角，并在故事中持续记录重要角色的变化。
  en: Helps create your hero and keeps important character details up to date during the story.
pluginType: core-plugin
relations:
  # The character panel surfaces character-presence portraits as avatar badges
  # when it's active (CharacterAvatar reads its `presence` namespace). Soft
  # companion only — the panel renders fine without it (no badge shown).
  recommends:
    - character-presence
---

# Character Creator
