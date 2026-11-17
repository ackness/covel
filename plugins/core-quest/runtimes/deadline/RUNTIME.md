---
description: >-
  Fails quests and objectives whose deadline has passed, and tells the story
  which deadlines are close.
schedule:
  stage: pre-turn
io:
  inputs:
    worldTime:
      from:
        contract: world-time-context@1
      required: false
  storyContext:
    select: /storyContext
    priority: high
function: {}
---

Deterministic and model-free. A quest or one of its objectives may carry a `deadline`: `{ when, label, missed? }`. `when` is one condition that holds once the deadline has passed (`lib/deadlines.js`): a world dimension at a path (`{ dimension, path, <operator> }`), a number of the world-time value (`{ time: elapsedSinceStart, gte: 45 }`), how an NPC feels about the player (`{ affinity: <name>, path: tier, in: [cold, hostile] }`, read from the single provider of the `affinity.tier@1` service as `{ score, tier }`), or a session turn (`{ turnGte: 6 }`). The operators are those of story-events conditions. `label` is what the player and the story read, and `missed` is what happens when the deadline passes.

Each turn, before the story, this runtime reads this turn's frozen dimensions and the world time of the execution:

1. An active quest whose deadline has passed becomes `failed`. It keeps `missed: { label, text, turn }`, so the quest log never makes it active or completed again.
2. An open objective whose deadline has passed is marked `missed`; its quest stays active, and the objective can no longer be done.
3. Each failure adds an entry to this turn's quest changes block (badge Failed or Missed, with the `missed` text). The quest's chips show `✗` for what was missed and `⌛ <label>` for each open deadline.
4. The output's `storyContext` (published through `story-context@1`) lists what failed now, which this turn's story must make happen, and every open deadline, with the time left when it counts world time. A retried turn tells the story the same failures again.

A deadline that cannot be judged, because its dimension, world time or affinity provider is not in the session, never fails a quest. The deadline passes on the turn after the one that ran out of time. This is by design: dimensions, world time and affinity settle after the story, so the next turn's story is the first one that can show the result; failing it after the story would put a failure in the quest log that no prose has shown.
