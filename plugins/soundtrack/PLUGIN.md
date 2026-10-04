---
id: soundtrack
kind: plugin
displayName: Soundtrack
description: >-
  Plays the background music a world ships, and follows the scene and the mood
  of the story.
tags:
  - "cost:function"
entry: ./server/index.js
contributes:
  extensions:
    - point: ui.slot@1
      id: music
      slot: stage.music@1
      order: 0
      watch:
        - state
        - tracks
        - assets
      preview:
        - music.cue
        - scene.set
  events:
    - topic: music.cue
      schema: ./schemas/music-cue.event.json
      description: >-
        Emit when the mood of the story clearly changes: the opening scene, the
        start or the end of a fight, a turn to fear, grief, or relief. Emit at
        most once per turn. Do not emit while the mood stays the same. The mood
        `silence` stops the music.
  data:
    assets:
      schema: ./schemas/assets.schema.json
      description: Music file index records imported from world packages.
      version: 1
      accepts:
        - stage.music-assets@1
      authoring:
        title: Music files
        hint: >-
          A directory of music files (`.mp3` or `.wav`). The world supplies only
          the files; the index records are produced at import.
        source:
          kind: media
          path: media/music
          key: filename
    tracks:
      schema: ./schemas/tracks.schema.json
      description: Track list imported from world packages.
      version: 1
      accepts:
        - stage.music-tracks@1
      authoring:
        title: Track list
        hint: >-
          One file that names each track, the music file it plays, and when it
          plays: in which scenes, for which moods, or as the theme of the world.
        example: ./examples/tracks.json
        source:
          kind: yaml
          path: media/music.yaml
          key: registryId
---

Soundtrack chooses the background music of a session from the tracks a world ships. Two facts decide the track: the current scene, taken from `scene.set`, and the mood, taken from `music.cue`. The choice goes to the `stage.music@1` slot; the app plays it. This root `PLUGIN.md` is metadata only — the runtimes that record the two facts live under `runtimes/`.
