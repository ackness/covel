---
id: scene-stage
kind: plugin
version: 0.0.35
displayName: Scene Stage
description: >-
  Tracks the current scene, time of day, and who is on stage for the visual
  stage.
tags:
  - "mode:dialogue"
  - "data:characters"
  - "cost:function"
  - "ui:right-panel"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
provides:
  - stage-direction@1
  - scene-stage@1
  - scene-cast@1
entry: ./server/index.js
contracts:
  scene-cast@1:
    schema: ./schemas/scene-cast.schema.json
contributes:
  extensions:
    - point: ui.slot@1
      id: cast
      slot: stage.cast@1
      order: 0
      watch:
        - active-cast
    - point: ui.slot@1
      id: backdrop
      slot: stage.backdrop@1
      order: 0
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
      preview:
        - stage.direction
    - point: ui.slot@1
      id: dialogue
      slot: stage.dialogue@1
      order: 0
      watch:
        - dialogue
      preview:
        - stage.direction
  events:
    - topic: stage.direction
      schema: ./schemas/stage-direction.event.json
      description: >-
        Emit once before each narrative. Merge all actor entry/exit, position,
        focus, and visual changes into cues. Supply dialogue.paragraphSpeakers
        with one exact character ID (from active-cast) per blank-line-separated
        narrative paragraph, in order; use null for narration, mixed speech, or
        unknown identities. Separate different speakers into paragraphs and keep
        the final paragraph count/order identical to the array. cues may be
        empty only when dialogue is provided. actor.focus controls the visual
        spotlight, not dialogue attribution. Specify an exit transition for
        actor.leave and stage.clear.
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
      version: 1
      accepts:
        - stage.scene-assets@1
      authoring:
        title: Scene background images
        hint: >-
          A directory of scene background image files. The world supplies only
          the files; the index records are produced at import.
        source:
          kind: media
          path: media/scenes
          key: filename
    scenes:
      schema: ./schemas/scenes.schema.json
      description: Scene background registry imported from world packages.
      version: 1
      accepts:
        - stage.scenes@1
      authoring:
        title: Scene registry
        hint: >-
          Do not write this file by hand. It maps scenes to background files by
          content hash. Generate the scene images first, then generate this
          file; see docs/guide/world-scenes.md.
        source:
          kind: json
          path: media/scenes.registry.json
          key: registryId
  ui:
    right:
      - ./runtimes/resolver/ui/scene-stage-panel.json
      - ./runtimes/cast/ui/scene-cast-panel.json
---

Scene Stage tracks the current scene/location and time of day for the visual stage, resolving `scene.set` events into `stage/current` against the world's scene registry; an unmatched location has no backdrop. Before each narrative its cast runtime picks the active speakers for `chat-mode-narrator` (`scene-cast@1`). It also applies structured `stage.direction` cues for actor presence, focus, position, and visual variants. This root `PLUGIN.md` is metadata only — executable runtimes live under `runtimes/`.
