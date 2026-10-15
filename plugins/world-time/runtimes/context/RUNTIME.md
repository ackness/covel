---
description: Provides the current time and the world's time rules to narration.
schedule:
  stage: pre-turn
io:
  output:
    contract: world-time-context@1
function: {}
---

Publishes authoritative time before narration. All initialization writes are transactional.
