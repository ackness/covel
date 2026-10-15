---
type: function
description: Computes the dimension values that the world declares as derived
  from the clock, without a model call.
schedule:
  stage: post-turn
  after:
    - world-init/dimension-tracker
io:
  inputs:
    worldTime:
      from:
        contract: world-time-evolution@1
      select: /summary
      required: false
function:
  handler: ./handler.js
---

Sets every `x-derive` field to the value the settled world clock gives. All writes use versioned dimension.update proposals.
