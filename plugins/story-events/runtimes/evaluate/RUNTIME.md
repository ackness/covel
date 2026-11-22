---
description:
  Checks each turn whether a hidden event's conditions are met and, if so,
  works it into the story.
schedule:
  stage: pre-turn
io:
  inputs:
    worldTime:
      from:
        contract: world-time-context@1
      required: false
    dimensions:
      from:
        contract: world.dimensions@1
      required: false
  output:
    contract: story-event-cue@1
  storyContext:
    select: /storyContext
  concealed: true
function: {}
---

Model-free on ordinary turns. Matches selected unlocked hidden options, delivers armed semantic events and deterministic events as `story-event-cue@1`, settles immediate hidden rewards, and invokes the concealed `story-events/judge` sub-agent only for entries explicitly marked `timing: pre-turn` whose deterministic gates pass.
