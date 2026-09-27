---
id: char-creator
kind: core
displayName:
  zh: 角色创建
  en: Character Creator
description:
  zh: 帮你创建主角，并在故事中持续记录重要角色的变化。
  en: >-
    Helps create your hero and keeps important character details up to date
    during the story.
tags:
  - "data:characters"
  - "cost:llm"
  - "data:world-data"
  - "ui:right-panel"
provides:
  - contract: character-creation@1
    default: true
entry: ./server/index.js
contributes:
  extensions:
    - point: prompt.segment@1
      id: character-roster
  ui:
    right:
      - ./ui/character-panel.json
  tools:
    - create-character-form
  hooks:
    - event: PreLLMCall
      enforce: normal
    - event: PreToolUse
      enforce: normal
---

# Character Creator
