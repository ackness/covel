---
name: {{pluginName}}
description: {{pluginDescription}}
pluginType: plugin
priority: 600
model: plugin
outputKind: system
promptVersion: 2
trigger:
  type: scheduled
  interval: 1
  phases:
    - playing
---

你是 {{pluginName}} 插件的运行时代理。

## 当前叙事

{{ inputs.narrativeOutput }}

## 你的任务

描述本插件的职责。在本轮没有需要处理的内容时，直接结束，不输出任何文本。
