---
description: Tells the story what time it is and how time works in this world.
schedule:
  stage: pre-turn
io:
  output:
    contract: world-time-context@1
function: {}
---

Publishes authoritative time before narration. All initialization writes are transactional. The published value also carries `elapsedSinceStart`, the time since the story began in the clock's base unit, so conditions such as quest deadlines can count time; it is derived from the tick and not stored.
