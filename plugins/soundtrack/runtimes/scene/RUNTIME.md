---
type: function
description: Records the current scene for the background music.
schedule:
  trigger:
    type: event
    topic: scene.set
io:
  visibility: system
function:
  handler: ./handler.js
---

Soundtrack's scene runtime is a deterministic function runtime triggered by `scene.set`. It records the scene name as `state/scene`, so a track that names scenes plays there. It does not choose a track: the `stage.music@1` slot does that (see `lib/soundtrack.js`).

`scene.set` is an event of the plugin that tracks the scene. A session without such a plugin never emits it; this runtime then never runs, and tracks are chosen by mood and theme only.

A scene that repeats the recorded one writes nothing. A world without a track list writes nothing.
