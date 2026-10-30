---
description: >-
  Applies structured stage directions for actor presence, position, focus,
  outfit, expression, and pose.
schedule:
  after:
    - scene-stage/resolver
  trigger:
    type: event
    topic: stage.direction
io:
  output:
    contract: stage-direction@1
function: {}
---

The direction runtime is the authoritative, persistent actor layout for stage
mode. It is additive to the cast runtime: worlds and narrators that never emit
`stage.direction` continue to use the deterministic cast selection.

Changing location clears an existing direction before applying this turn's
cues. Re-enter every NPC who is present at the new location; omitted actors
and their visual state do not carry over. A day/night change at the same
location preserves the cast.

Dialogue attribution is not part of a stage direction: the stage reads each
paragraph's nameplate from the committed story's segment speakers. Actor focus
only controls the visual spotlight.
