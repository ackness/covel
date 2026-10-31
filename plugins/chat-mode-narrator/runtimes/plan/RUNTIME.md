---
description: Prepare an optional name-only cast and turn policy plan.
schedule:
  stage: pre-turn
io:
  inputs:
    active-cast:
      from:
        contract: scene-cast@1
      required: false
    previous:
      from:
        runtime: chat-mode-narrator/narrate
      scope: committed
      recordAs: latest-story
      required: false
  output:
    schema: ./output.schema.json
function:
  model: plugin
---

Read the structured scene speakers and the prior committed story, project an eligible cast, and ask the selected policy once. This function never delegates actors or writes state. The narrative agent consumes its optional output.
