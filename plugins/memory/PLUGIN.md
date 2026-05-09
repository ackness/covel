---
name: memory
description:
  zh: 展示故事记住的重点，包括剧情、场景、人物关系和主角状态。
  en: Shows what the story remembers, including plot, scene, relationships, and hero status.
pluginType: core-plugin
outputKind: system
capabilities:
  - memory-panel
tags:
  - role:memory
  - cost:ui-only
  - ui:right-panel
trigger:
  type: manual
ui:
  right:
    - ./ui/memory-panel.json
relations: {}
---

纯 UI 插件。核心记忆的读写由框架 Memory System（@covel/memory）在每轮结束后自动完成，本插件仅声明右侧面板。
