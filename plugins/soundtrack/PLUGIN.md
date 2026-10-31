---
version: 0.0.6
displayName: Soundtrack
description: >-
  Plays the background music a world ships, and follows the scene and the mood
  of the story.
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
contributes:
  extensions:
    - prompt.segment@1/music-moods
    - point: ui.slot@1
      id: music
      slot: stage.music@1
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
        Emit only when the prompt lists music moods for this world. Emit when
        the mood of the story clearly changes to one of the listed moods, with
        that mood written exactly as listed. Emit at most once per turn. Do
        not emit while the mood stays the same. The mood `silence` stops the
        music.
  data:
    assets:
      schema: ./schemas/assets.schema.json
      description: Music file index records imported from world packages.
      accepts:
        - stage.music-assets@1
      authoring:
        title: Music files
        hint: >-
          A directory of music files (`.mp3` or `.wav`). The world supplies only
          the files; the index records are produced at import.
        source:
          path: media/music
    tracks:
      schema: ./schemas/tracks.schema.json
      description: Track list imported from world packages.
      accepts:
        - stage.music-tracks@1
      authoring:
        title: Track list
        hint: >-
          One file that names each track, the music file it plays, and when it
          plays: in which scenes, for which moods, or as the theme of the world.
          The moods are your own words; `moods` at the top says when each
          applies.
        example: ./examples/tracks.json
        source:
          path: media/music.yaml
          key: registryId
---

Soundtrack chooses background music from the tracks a world ships. Its post-turn `story-cues` runtime reads the optional `narrative-engine@2` story input and records `cues.scene` and known `cues.mood` values. It does not activate a narrator. The `scene` and `cue` event runtimes still accept `scene.set` and `music.cue` as overrides. The choice goes to `stage.music@1`; the app plays it. Executable runtimes live under `runtimes/`.
