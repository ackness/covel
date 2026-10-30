---
description: Follows the story's mood and scene cues for background music.
schedule:
  stage: post-turn
io:
  inputs:
    story:
      from:
        contract: narrative-engine@2
      required: false
function: {}
---

Reads the current story's optional `cues` in the story's execution. A known
`mood` records the world's spelling in `state/mood`; an unknown mood keeps the
current music. `scene` records its trimmed name in `state/scene`, independently
of any scene plugin. No story, relevant cue, or world track list means a
successful skip with a reason. Event runtimes remain available as overrides.
