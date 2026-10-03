---
id: char-creator
kind: core
displayName: Character Creator
description: >-
  Helps create your hero and keeps important character details up to date during
  the story.
tags:
  - "data:characters"
  - "cost:llm"
  - "data:world-data"
  - "ui:right-panel"
provides:
  - contract: character-creation@1
    default: true
requires:
  - session.opening@1
  - world-data-provider@1
  - narrative-engine@1
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
