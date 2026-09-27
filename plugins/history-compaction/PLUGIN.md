---
id: history-compaction
kind: core
displayName: History Compaction
description: Maintains bounded rolling summaries of older conversation history.
provides:
  - contract: history.compact@1
    default: true
entry: ./server/index.js
contributes:
  extensions:
    - point: history.compact@1
      id: rolling-summary
---

# History Compaction

Protects recent turns and merges older dialogue with the previous rolling summary. The kernel controls budget admission and atomically persists validated compaction results. Source messages remain stored.
