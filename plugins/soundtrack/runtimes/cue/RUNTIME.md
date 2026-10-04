---
type: function
description: Records the mood of the story for the background music.
schedule:
  trigger:
    type: event
    topic: music.cue
io:
  visibility: system
function:
  handler: ./handler.js
---

Soundtrack's cue runtime is a deterministic function runtime triggered by `music.cue`. It records the mood as `state/mood`. It does not choose a track: the `stage.music@1` slot does that from the mood, the scene and the world's track list (see `lib/soundtrack.js`).

A cue that repeats the recorded mood writes nothing. A world without a track list writes nothing.
