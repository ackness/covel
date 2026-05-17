---
name: {{pluginName}}/note
description:
  zh: 玩家点击侧栏按钮时，向本插件 notes namespace 写入一条结构化记录。函数 runtime 起点。
  en: Writes a structured record into this plugin's `notes` namespace when triggered from the sidebar. Function-runtime starter.
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
capabilities: [manual-invoke]
execution: sync
trigger:
  type: manual
ui:
  right:
    - ./ui/panel.json
---
