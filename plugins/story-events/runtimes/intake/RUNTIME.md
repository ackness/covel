---
description: Adds new hidden events planned during play, after checking them.
schedule:
  stage: post-turn
io:
  inputs:
    plans:
      from:
        contract: story-event.plan@1
        cardinality: all
      required: false
    worldTime:
      from:
        contract: world-time-context@1
      required: false
    dimensions:
      from:
        contract: world.dimensions@1
      required: false
  concealed: true
function: {}
---

Deterministic and model-free. Planned events are stored in the plugin's hidden `_hidden.planned` bucket, never replace world-authored events or events that already fired, and fire at most once. The report names event IDs and reasons only, never payloads.
