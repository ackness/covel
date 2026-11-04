---
kind: core
version: 0.0.50
displayName: Character Creator
description: >-
  Helps you create your hero and keeps track of the characters you meet in
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
  - narrative-engine@2
contributes:
  extensions:
    - prompt.segment@1/character-roster
  ui:
    right:
      - ./ui/character-panel.json
  tools:
    - create-character-form
  forms:
    - player-name
  hooks:
    - PreLLMCall
    - PreToolUse
---

# Character Creator
