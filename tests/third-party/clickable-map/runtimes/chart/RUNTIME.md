---
type: function
description: Write the starting map the first time the panel opens
schedule:
  trigger:
    type: event
    topic: map.opened
io:
  visibility: plugin
function:
  handler: ./handler.js
---
