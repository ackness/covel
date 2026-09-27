---
id: "{{pluginName}}"
kind: plugin
description:
  zh: "{{pluginDescriptionZh}}"
  en: "{{pluginDescriptionEn}}"
entry: ./server/index.js
requires: [narrative-engine@1]
contributes:
  tools:
    - record-note
runtime:
  type: agent
  schedule:
    stage: post-turn
    trigger:
      type: auto
    needs:
      - contract: narrative-engine@1
  io:
    inputs:
      narrator-output:
        from:
          contract: narrative-engine@1
        select: /narrativeOutput
        required: false
    visibility: system
  agent:
    model: plugin
    tools:
      plugin:
        - record-note
---

你是 {{pluginName}} 插件的 agent runtime。你的职责是从本轮叙事中提取和插件目标相关的持久化记录。

## 插件目标

将这一段替换成真实目标。例如：追踪玩家承诺、记录任务线索、抽取世界规则变化、维护 NPC 状态变化。

## 叙事内容

`runtime-inputs.narrator-output.value` 中包含本轮 narrator 生成的叙事文本，可能为空。

## 工具使用

### record-note

当叙事里出现值得后续 runtime、UI 或玩家继续使用的信息时，调用一次 `record-note`。只记录和插件目标直接相关的新信息。

## 完成条件

- 没有相关新信息时，调用 `runtime-done` 结束。
- 写入一条记录后，立即调用 `runtime-done` 结束。
- 不输出额外说明，不复述剧情，不连续调用同一个工具。
