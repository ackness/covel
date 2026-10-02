---
id: character-blueprint
kind: plugin
displayName:
  zh: 角色资料
  en: Character Profiles
description:
  zh: 保存世界预设的人物资料，以及他们的头像、立绘和声音。
  en: >-
    Saves the world's preset character profiles along with their portraits,
    sprites, and voices.
tags:
  - "data:world-data"
  - "data:characters"
  - "data:media-assets"
  - "cost:function"
  - "ui:right-panel"
  - "ui:manual-action"
provides:
  - character-blueprint@1
  - character-presence@1
entry: ./server/index.js
contracts:
  character.blueprints@1:
    schema: ./schemas/blueprints.schema.json
  character.portraits@1:
    schema: ./schemas/presence.schema.json
  character.portrait-assets@1:
    schema: ./schemas/assets.schema.json
contributes:
  extensions:
    - point: ui.slot@1
      id: visuals
      slot: character.visual@1
      order: 0
      watch:
        - presence
  data:
    blueprints:
      schema: ./schemas/blueprints.schema.json
      description: Importable world character blueprints.
      version: 1
      accepts:
        - character.blueprints@1
    presence:
      schema: ./schemas/presence.schema.json
      description: Importable character media presence records.
      version: 1
      accepts:
        - character.portraits@1
    assets:
      schema: ./schemas/assets.schema.json
      description: Media asset index records imported from world packages.
      version: 1
      accepts:
        - character.portrait-assets@1
  ui:
    right:
      - ./ui/blueprints-panel.json
      - ./ui/character-presence-panel.json
---

Character Profiles holds the world's preset cast. The `import` runtime stores a
character blueprint and can instantiate it as a session character; the
`presence` runtime stores a character's portrait, sprite, voice, and visual
variants, which the `character.visual@1` slot projects onto the stage. Both are
manual function runtimes; world packages fill the same namespaces through
world data. This root `PLUGIN.md` is metadata only — executable runtimes live
under `runtimes/`.
