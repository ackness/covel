---
type: function
description: Checks hidden events against current dimensions and world time each
  turn, handing narration this turn's cue when one is met.
schedule:
  stage: pre-turn
  trigger:
    type: scheduled
    interval: 1
io:
  inputs:
    worldTime:
      from:
        contract: world-time-context@1
        cardinality: one
      required: false
    dimensions:
      from:
        contract: world.dimensions@1
        cardinality: one
      required: false
  output:
    contract: story-event-cue@1
  visibility: system
  concealed: true
function:
  handler: ./handler.js
---

Deterministic and model-free. Hidden event payloads are read from the plugin's hidden bucket and only leave it as this turn's cue.
