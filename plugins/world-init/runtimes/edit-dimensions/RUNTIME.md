---
description: Lets you correct a value, or handle a waiting update by hand or skip it.
schedule:
  trigger:
    type: manual
io:
  inputs:
    narrative:
      from: { contract: narrative-engine@2 }
      select: /narrativeOutput
      required: false
    worldIR:
      from: { contract: world-ir-provider@1 }
      required: false
function: {}
---

Manual runtime RPC. All writes use versioned dimension.update proposals.
