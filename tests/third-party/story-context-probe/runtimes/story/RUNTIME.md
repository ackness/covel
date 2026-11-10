---
description: Write a deterministic story from the turn's notes
schedule:
  stage: narrative
io:
  inputs:
    context:
      from: { kernel: story-context@1 }
  output:
    contract: narrative-engine@2
  visibility: story
function: {}
---
