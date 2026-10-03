---
id: character-blueprint
kind: plugin
displayName: Character Profiles
description: >-
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
      authoring:
        title: Preset characters
        hint: >-
          Write one record for each preset character. `role` is a character type
          the world declares in `characterSchema.types`. Use the world's
          `characterSchema` attribute IDs as the keys of `attributes`. `persona`
          holds a summary, traits, goals, fears and `voice`; `voice` says how
          the character speaks. Keep names identical to the lore.
        example: ./examples/blueprints.json
        source:
          kind: json
          path: characters/main-cast.json
          key: id
    presence:
      schema: ./schemas/presence.schema.json
      description: Importable character media presence records.
      version: 1
      accepts:
        - character.portraits@1
      authoring:
        title: Character portrait mapping
        hint: >-
          Do not write this file by hand. It maps characters to portrait files
          by content hash. Generate the portraits first, then generate this
          file; see docs/guide/world-portraits.md.
        source:
          kind: json
          path: media/presence.json
          key: characterId
    assets:
      schema: ./schemas/assets.schema.json
      description: Media asset index records imported from world packages.
      version: 1
      accepts:
        - character.portrait-assets@1
      authoring:
        title: Character portrait images
        hint: >-
          A directory of portrait image files. The world supplies only the
          files; the index records are produced at import.
        source:
          kind: media
          path: media/portraits
          key: filename
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
