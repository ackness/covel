---
type: function
description:
  zh: 接收其他 runtime 在剧情推进中提出的后续隐藏事件，校验后加入隐藏事件表。
  en: Accepts follow-up hidden events planned by other runtimes during play, validating them before they join the hidden event table.
schedule:
  stage: post-turn
  trigger:
    type: scheduled
    interval: 1
io:
  inputs:
    plans:
      from:
        contract: story-event.plan@1
        cardinality: all
      required: false
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
  visibility: system
  concealed: true
function:
  handler: ./handler.js
---

Deterministic and model-free. Planned events are stored in the plugin's hidden `_hidden.planned` bucket, never replace world-authored events or events that already fired, and fire at most once. The report names event IDs and reasons only, never payloads.
