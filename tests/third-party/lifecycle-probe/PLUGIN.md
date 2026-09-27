---
id: lifecycle-probe
kind: plugin
displayName:
  zh: 插件生命周期测试
  en: Plugin Lifecycle Probe
description:
  zh: 独立第三方测试包，验证安装、审批、运行和卸载。
  en: "Standalone third-party install, approval, runtime, and uninstall probe."
provides:
  - scene-prompts@1
  - narrative-engine@1
entry: ./server/index.js
contracts:
  lifecycle-probe.notes.initial@1:
    schema: ./schemas/note.schema.json
contributes:
  commands:
    - name: probe
      description:
        zh: 查看插件测试状态
        en: Show plugin probe status
      action: probe-status
  settings:
    - key: voice
      type: select
      default: concise
      label:
        zh: 测试风格
        en: Test style
      options:
        - value: concise
          label:
            zh: 简洁
            en: Concise
        - value: detailed
          label:
            zh: 详细
            en: Detailed
    - key: label
      type: text
      default: fixture
      label:
        zh: 记录前缀
        en: Record prefix
    - key: count
      type: integer
      default: 1
      min: 1
      max: 5
      label:
        zh: 测试数值
        en: Test number
    - key: enabled
      type: toggle
      default: true
      label:
        zh: 启用记录
        en: Enable records
  ui:
    message:
      - ./runtimes/cards/ui/cards.json
    right:
      - ./runtimes/note/ui/panel.json
  data:
    notes:
      schema: ./schemas/note.schema.json
      version: 1
      accepts:
        - lifecycle-probe.notes.initial@1
  tools:
    - lifecycle-probe-record
    - lifecycle-probe-cards
  hooks:
    - event: TurnStart
      enforce: normal
    - event: SessionEnd
      enforce: normal
  actions:
    - probe-status
---

# Plugin Lifecycle Probe

Test-only package. Executable runtimes live under `runtimes/`.
