---
type: function
description:
  zh: 第一次打开地图时写入初始地图
  en: Write the starting map the first time the panel opens
schedule:
  trigger:
    type: event
    topic: map.opened
io:
  visibility: plugin
function:
  handler: ./handler.js
---
