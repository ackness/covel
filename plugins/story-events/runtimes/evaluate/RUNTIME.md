---
type: function
description:
  zh: 每回合用当前维度与世界时间判断隐藏事件是否满足条件，满足时向叙事交出本回合的剧情提示。
  en: Checks hidden events against current dimensions and world time each turn, handing narration this turn's cue when one is met.
schedule:
  stage: pre-turn
  trigger:
    type: scheduled
    interval: 1
io:
  inputs:
    worldTime:
      from:
        contract: world-time-context@1
        cardinality: one
      required: false
    dimensions:
      from:
        contract: world.dimensions@1
        cardinality: one
      required: false
  output:
    contract: story-event-cue@1
  visibility: system
function:
  handler: ./handler.js
---

Deterministic and model-free. Hidden event payloads are read from the plugin's hidden bucket and only leave it as this turn's cue.
