---
type: function
description: Update memory blocks from the completed source turn.
schedule:
  stage: post-turn
  trigger:
    type: auto
  completion:
    mode: detached
    settle: before-next-execution
    maxSettleWaitMs: 30000
    maxQueueMs: 300000
    maxExecutionMs: 120000
    overlap: serial
    stalePolicy: reject
io:
  inputs:
    turn:
      from:
        kernel: turn-digest@1
  visibility: system
function:
  timeoutMs: 120000
  handler: ../../server/extract.js
effects:
  reads:
    - "plugin-data:self:blocks"
    - "plugin-data:self:definitions"
  writes:
    - "plugin-data:self:blocks"
---

The runtime consumes a frozen source-turn digest, updates its own blocks, and
commits through the normal detached execution transaction.
