---
version: 0.0.38
displayName: Character Profiles
description: >-
  Saves the world's preset character profiles along with their portraits,
  sprites, and voices.
tags:
  - "data:world-data"
  - "data:characters"
  - "data:media-assets"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
provides:
  - character-blueprint@1
contributes:
  extensions:
    - prompt.segment@1/character-notes
    - point: ui.slot@1
      id: visuals
      slot: character.visual@1
      watch:
        - presence
  data:
    blueprints:
      schema: ./schemas/blueprints.schema.json
      description: Roleplay notes of the world's characters, by character id.
      accepts:
        - character.blueprints@1
      authoring:
        title: Roleplay notes
        hint: >-
          Write the notes in the record of the character they are for, under
          `blueprint`. The record already gives the character's name,
          description, type and fields: do not repeat them. The narrative
          reads the notes of the characters in the session, except the
          player's. It plays a character from `persona` (`summary`, `traits`,
          `goals`, `fears`, `secrets`, `voice`, `style`), from `rules` (at
          most three, highest `priority` first), from `dialogueExamples` (at
          most two) and from `scenarioDefaults.relationships`, whose keys are
          `player`, a character's id or the id of a dimension entry. `voice`
          says how the character speaks. A secret is for the narrator, who
          does not state it before the story reveals it.
        example: ./examples/blueprint.json
        generate: default
        characterField: blueprint
    presence:
      schema: ./schemas/presence.schema.json
      description: Importable character media presence records.
      accepts:
        - character.portraits@1
      authoring:
        title: Character portrait mapping
        hint: >-
          Do not write this file by hand. It maps characters to portrait files
          by content hash. Generate the portraits first, then generate this
          file; see docs/worlds/portraits.md.
        source:
          path: media/presence.json
          key: characterId
    assets:
      schema: ./schemas/assets.schema.json
      description: Media asset index records imported from world packages.
      accepts:
        - character.portrait-assets@1
      authoring:
        title: Character portrait images
        hint: >-
          A directory of portrait image files. The world supplies only the
          files; the index records are produced at import.
        source:
          path: media/portraits
  ui:
    right:
      - ./ui/character-presence-panel.json
---

Character Profiles holds the roleplay notes and portraits of the world's
characters. A world writes a character's notes in that character's record
(`blueprint`), and the kernel imports them into `blueprints`, keyed by the
character's id; `presence` and `assets` come from the world's media. The notes
are read-only during play. The manual `presence` runtime stores a character's
portrait, sprite, voice, and visual variants, which the `character.visual@1`
slot projects onto the stage: the portrait panel calls it when the player
uploads a replacement portrait. A `prompt.segment@1` provider gives story runtimes the roleplay
notes of each character in the session (`<character-notes>`). This root `PLUGIN.md` is metadata only — executable runtimes live
under `runtimes/`.
