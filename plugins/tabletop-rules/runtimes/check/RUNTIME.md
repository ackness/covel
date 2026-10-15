---
type: function
description: Submit an attribute check without rerolling on retries
schedule:
  stage: pre-turn
io:
  inputs:
    rules:
      from:
        runtime: tabletop-rules/creation
      select: /rules
      required: false
  output:
    contract: tabletop-check@1
function:
  handler: ./handler.js
  tools:
    builtin: [list-characters, create-form]
---
