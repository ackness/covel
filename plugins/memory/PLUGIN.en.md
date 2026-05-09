---
name: memory
description:
  zh: 展示故事记住的重点，包括剧情、场景、人物关系和主角状态。
  en: Shows what the story remembers, including plot, scene, relationships, and hero status.
pluginType: core-plugin
outputKind: system
capabilities:
  - memory-panel
trigger:
  type: manual
ui:
  right:
    - ./ui/memory-panel.json
---

Pure UI plugin. Core-memory reads and writes are handled automatically by the framework's Memory System (@covel/memory) at the end of every turn. This plugin only declares the right-hand panel.
