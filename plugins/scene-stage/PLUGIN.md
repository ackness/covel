---
version: 0.0.41
displayName: Scene Stage
description: >-
  Tracks the current scene, time of day, and who is on stage for the visual
  stage.
tags:
  - "mode:dialogue"
  - "data:characters"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
contracts:
  scene-cast@1:
    schema: ./schemas/scene-cast.schema.json
contributes:
  extensions:
    - point: ui.slot@1
      id: cast
      slot: stage.cast@1
      watch:
        - active-cast
    - point: ui.slot@1
      id: backdrop
      slot: stage.backdrop@1
      watch:
        - stage
        - scenes
      preview:
        - scene.set
    - point: ui.slot@1
      id: direction
      slot: stage.cast@1
      order: 10
      watch:
        - direction
        - stage
        - scenes
      preview:
        - stage.direction
        - scene.set
  events:
    - topic: stage.direction
      schema: ./schemas/stage-direction.event.json
      description: >-
        Emit once before a narrative in which actors change. Merge all actor
        entry/exit, position, focus, and visual changes into cues. actor.focus
        controls the visual spotlight; nameplates come from the story's
        segment speakers. Specify an exit transition for actor.leave and
        stage.clear. On a location change, re-enter every NPC at the new
        location: existing direction actors are cleared before these cues.
    - topic: scene.set
      schema: ./schemas/scene-set.event.json
      description: >-
        Emission conditions (any one requires emitting, at most once per turn):
        the very first turn establishing the opening scene, a scene/location
        change, or a day-night shift. Use the in-narrative location name; keep
        previous values when unsure.
  settings:
    - key: activeSpeakerCount
      type: number
      default: 2
      min: 1
      max: 4
      step: 1
      label: Active speakers
  data:
    assets:
      schema: ./schemas/assets.schema.json
      description: Scene backdrop media index records imported from world packages.
      accepts:
        - stage.scene-assets@1
      authoring:
        title: Scene background images
        hint: >-
          A directory of scene background image files. The world supplies only
          the files; the index records are produced at import.
        source:
          path: media/scenes
    scenes:
      schema: ./schemas/scenes.schema.json
      description: Scene background registry imported from world packages.
      accepts:
        - stage.scenes@1
      authoring:
        title: Scene registry
        hint: >-
          Do not write this file by hand. It maps scenes to background files by
          content hash. Generate the scene images first, then generate this
          file; see docs/worlds/scenes.md.
        source:
          path: media/scenes.registry.json
          key: registryId
  ui:
    segment:
      - ./ui/dialogue-line.json
    right:
      - ./runtimes/resolver/ui/scene-stage-panel.json
      - ./runtimes/cast/ui/scene-cast-panel.json
---

Scene Stage's post-turn `story-cues` runtime reads the optional `narrative-engine@2` story input: `cues.scene` selects a backdrop while preserving day/night, and non-empty `cues.present` selects actors with focus from segment speakers. It does not activate a narrator. `scene.set` still sets locations and day/night; `stage.direction` overrides actor presence, focus, position, and visual variants. Before narration, `cast` picks active speakers for `scene-cast@1`; `seed` supplies the opening backdrop. A dialogue segment template adds a nameplate and any available avatar in chat. Executable runtimes live under `runtimes/`.
