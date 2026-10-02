---
type: function
description:
  zh: 在事实抽取前公布背包里的物品名，便于沿用同一名称。
  en: >-
    Publishes the names of the items in the bag before fact extraction so the
    same names are reused.
schedule:
  stage: pre-turn
  trigger:
    type: auto
io:
  output:
    contract: world-ir.vocabulary@1
  visibility: system
function:
  handler: ./handler.js
---

Publishes up to 80 carried item names as `world-ir.vocabulary@1` entries of type `item`. Lost items (tombstones) are left out. The extractor uses the list to align names only; it is never evidence of a change.
