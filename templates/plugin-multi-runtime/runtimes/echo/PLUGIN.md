---
name: {{pluginName}}/echo
description:
  zh: 玩家点击侧栏 Echo 按钮时写入一条 "hello" 到本插件的 messages namespace。函数 runtime 最小示例。
  en: Writes a single "hello" record into this plugin's `messages` namespace when the player clicks the sidebar Echo button. Minimal function-runtime example.
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
