---
description: Gives the story this turn's world state. Makes no AI call.
schedule:
  stage: pre-turn
io:
  output:
    contract: world.dimensions@1
function: {}
effects:
  reads:
    - "plugin-data:self:_dimensions"
  writes: []
---

Publishes committed values only. The host checks pending settlement before narration.
