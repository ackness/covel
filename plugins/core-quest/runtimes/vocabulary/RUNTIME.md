---
description: >-
  Publishes active quests and their open objectives before fact extraction so
  the same names are reused.
schedule:
  stage: pre-turn
  after:
    - core-quest/deadline
io:
  output:
    contract: world-ir.vocabulary@1
function: {}
---

Publishes up to 30 active quests as `world-ir.vocabulary@1` entries of type `quest`, with their open objectives as `details`. Completed and failed quests, and objectives whose deadline passed, are left out. It runs after `core-quest/deadline`, so a quest that fails this turn is not published. The extractor uses the list to align names only; it is never evidence of progress.
