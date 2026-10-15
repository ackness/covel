---
type: function
description: Edits current values or explicitly resolves a pending settlement
  manually or by skipping.
schedule:
  trigger:
    type: manual
io:
  inputs:
    narrative:
      from: { contract: narrative-engine@1 }
      select: /narrativeOutput
      required: false
    worldIR:
      from: { contract: world-ir-provider@1 }
      required: false
function:
  handler: ./handler.js
---

Manual runtime RPC. All writes use versioned dimension.update proposals.
