---
description: >-
  Assesses hidden conditions, unlocks hidden options, and settles hidden rewards
  after each turn settles.
schedule:
  stage: audit
io:
  inputs:
    narrative:
      from:
        contract: narrative-engine@2
      select: /segments
      required: false
    worldIR:
      from:
        contract: world-ir@2
      required: false
    worldTime:
      from:
        contract: world-time-evolution@1
      select: /summary
      required: false
    cue:
      from:
        contract: story-event-cue@1
      required: false
    operations:
      from:
        kernel: operations@1
  concealed: true
function: {}
---

Runs after the `post-turn` stage barrier so updated dimensions, world time, affinity, and bag writes are already visible in the execution overlay. Evaluates deterministic short-circuits first, invokes the concealed `story-events/judge` sub-agent at most once per turn only when shortlisted semantic leaves remain, arms newly met hidden events for zero-latency reveal on the next turn, projects unlocked public options, and settles hidden rewards atomically.
