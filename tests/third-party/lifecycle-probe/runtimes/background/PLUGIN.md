---
name: lifecycle-probe/background
description:
  { zh: 后台写入测试记录, en: Write a test record in a background job }
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
capabilities: [manual-invoke]
execution: background
trigger: { type: manual }
---
