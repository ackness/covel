---
name: scene-stage/background-gen
description:
  zh: 后台生成缺失的场景背景图
  en: Generates missing scene backgrounds in the background
pluginType: plugin
runtimeType: function
resultFormat: envelope-v1
handler: ./handler.js
priority: 900
outputKind: plugin
capabilities: [image-generation]
tags:
  - mode:dialogue
  - role:scene-state
  - cost:function
execution: background
timeoutMs: 360000
trigger:
  type: event
  topic: scene-stage.generate.requested
---

Background-gen calls the framework image pipeline (`ctx.images`) to render a scene background from the registry's shared `style` block plus the scene's `visualHint`. Runs off the turn's critical path; day variants generate first, night variants lazily on first request.
