---
type: function
description:
  zh: 玩家在地图上选了地点后移动过去
  en: Move the player to the place selected on the map
schedule:
  trigger:
    type: event
    topic: map.location-selected
io:
  visibility: plugin
function:
  handler: ./handler.js
---
