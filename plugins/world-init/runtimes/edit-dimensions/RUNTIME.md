---
type: function
description:
  zh: 玩家修正维度当前值，或明确人工处理/跳过待结算回合。
  en: Edits current values or explicitly resolves a pending settlement manually or by skipping.
schedule:
  trigger:
    type: manual
io:
  inputs:
    narrative:
      from: { contract: narrative-engine@1, cardinality: one }
      select: /narrativeOutput
      required: false
    worldIR:
      from: { contract: world-ir-provider@1, cardinality: one }
      required: false
  visibility: system
function:
  handler: ./handler.js
---

Manual runtime RPC. All writes use versioned dimension.update proposals.
