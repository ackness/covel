---
name: memory
description:
  zh: 核心记忆面板。纯 UI 插件，不参与调度。展示 Letta 式三层记忆系统的当前状态（剧情摘要、当前场景、角色关系、玩家状态）。
  en: Core memory panel. UI-only plugin that does not participate in the scheduler. Visualises the three-tier Letta-style memory system (story summary, current scene, character relationships, player status).
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
