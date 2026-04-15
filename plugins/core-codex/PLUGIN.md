---
name: core-codex
description: 知识图鉴系统（function runtime）。用确定性算法从叙事文本中抽取人物/物品/地点/传说/技能条目，写入 plugin_data 并触发图鉴 UI。
pluginType: plugin
priority: 650
outputKind: system
runtimeType: function
handler: ./handler.js
timeoutMs: 120000
trigger:
  type: scheduled
  interval: 2
  cooldownTurns: 1
  phases:
    - playing
ui:
  right:
    - ./ui/codex-panel.json
  message:
    - ./ui/codex-message.json
---

## 这是一个 function runtime

该 runtime 不调用 LLM。框架会直接执行 `handler.js`，handler 从 `completedResults.get('core-narrator')` 读取上一段叙事，运行确定性的标题抽取规则（黑名单前缀、片段过滤、类别启发式），再把命中的条目写入 `plugin_data[namespace="entries"]`。

设计意图见 `docs/guide/plugin-authoring.md` "段职责约定" 章节：core-codex 是一次性消化 narrator 输出的 post-narrator runtime；为避免重复写入而做的去重发生在 handler 内部，而非通过跨 runtime 的 input.inject 协议。

实现细节请直接阅读 `handler.js`。该文件之前残留的"agent 工具调用流程"提示词与实际运行无关，已删除。
