---
description:
  Updates the values that follow the world clock, such as the date. Makes no
  AI call.
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
function: {}
---

Sets every `x-derive` field to the value the settled world clock gives. All writes use versioned dimension.update proposals.
