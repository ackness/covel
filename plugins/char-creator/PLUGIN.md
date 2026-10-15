---
kind: core
version: 0.0.39
displayName: Character Creator
description: >-
  Helps create your hero and keeps important character details up to date during
  the story.
tags:
  - "data:characters"
  - "data:world-data"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
provides:
  - contract: character-creation@1
    default: true
requires:
  - session.opening@1
  - world-data-provider@1
  - narrative-engine@1
contributes:
  extensions:
    - point: prompt.segment@1
      id: character-roster
  ui:
    right:
      - ./ui/character-panel.json
  tools:
    - create-character-form
  forms:
    - player-name
  hooks:
    - event: PreLLMCall
    - event: PreToolUse
---

# Character Creator
