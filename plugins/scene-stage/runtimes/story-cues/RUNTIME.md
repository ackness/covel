---
description: Follows the story's scene, presence, and speaker cues on stage.
schedule:
  stage: post-turn
io:
  inputs:
    story:
      from:
        contract: narrative-engine@2
      required: false
function: {}
---

Reads the current story's optional `cues` in the story's execution. A scene
change uses the world's registry and keeps the current day/night variant.
Non-empty `present` names replace the actor list, excluding the primary
seat's current character. Continuing actors keep their visual and position;
new actors fade in at free positions from left to right. Focus follows the
last resolved dialogue or action speaker on stage. Without presence cues,
only a scene change clears the existing actors. Events remain overrides.
