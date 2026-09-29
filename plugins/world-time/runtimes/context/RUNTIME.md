---
type: function
description:
  zh: 向叙事提供当前时间及世界的时间规则。
  en: Provides the current time and the world's time rules to narration.
schedule:
  stage: pre-turn
  trigger:
    type: scheduled
    interval: 1
io:
  output:
    contract: world-time-context@1
  visibility: system
function:
  handler: ./handler.js
---

Publishes authoritative time before narration. All initialization writes are transactional.
