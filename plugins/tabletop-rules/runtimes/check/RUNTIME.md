---
description: Roll an ability check once, even if the turn is retried
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
  tools:
    builtin: [create-form]
---
