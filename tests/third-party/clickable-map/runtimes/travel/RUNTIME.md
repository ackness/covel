---
type: function
description: Move the player to the place selected on the map
schedule:
  trigger:
    type: event
    topic: map.location-selected
io:
  visibility: plugin
function:
  handler: ./handler.js
---
