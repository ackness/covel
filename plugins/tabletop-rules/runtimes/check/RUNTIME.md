---
type: function
description:
  zh: 提交属性检定，结果不会因重试而重掷
  en: Submit an attribute check without rerolling on retries
schedule:
  stage: pre-turn
  trigger:
    type: scheduled
    interval: 1
io:
  inputs:
    rules:
      from:
        runtime: tabletop-rules/creation
      select: /rules
      required: false
  output:
    contract: tabletop-check@1
  visibility: system
function:
  handler: ./handler.js
  tools:
    builtin: [list-characters, create-form]
---
