---
type: function
description: Tracks who is present in the scene and who is currently speaking.
schedule:
  stage: pre-turn
  trigger:
    type: scheduled
    interval: 1
io:
  output:
    contract: scene-cast@1
  visibility: system
function:
  handler: ./handler.js
---

The cast runtime runs before narration each turn. It scores the session's
non-player characters against the player message and recent narrative text,
keeps up to `activeSpeakerCount` of them, and publishes compact cast context
(`scene-cast@1`) for `chat-mode-narrator`. The selection is written to
`active-cast/current`, which also feeds the `stage.cast@1` slot until
`stage.direction` produces actor state.
