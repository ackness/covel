---
type: function
description: Produce a deterministic test story
schedule:
  stage: narrative
  trigger:
    type: auto
io:
  output:
    contract: narrative-engine@1
  visibility: story
function:
  handler: ./handler.js
---
