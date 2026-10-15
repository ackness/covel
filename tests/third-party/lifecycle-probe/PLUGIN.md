---
version: 1.0.0
displayName: Plugin Lifecycle Probe
description: "Standalone third-party install, approval, runtime, and uninstall probe."
contracts:
  lifecycle-probe.notes.initial@1:
    schema: ./schemas/note.schema.json
contributes:
  commands:
    - name: probe
      description: Show plugin probe status
      action: probe-status
  settings:
    - key: voice
      type: select
      default: concise
      label: Test style
      options:
        - value: concise
          label: Concise
        - value: detailed
          label: Detailed
    - key: label
      type: text
      default: fixture
      label: Record prefix
    - key: count
      type: integer
      default: 1
      min: 1
      max: 5
      label: Test number
    - key: enabled
      type: toggle
      default: true
      label: Enable records
  ui:
    message:
      - ./runtimes/cards/ui/cards.json
    right:
      - ./runtimes/note/ui/panel.json
  data:
    notes:
      schema: ./schemas/note.schema.json
      accepts:
        - lifecycle-probe.notes.initial@1
  tools:
    - lifecycle-probe-record
    - lifecycle-probe-cards
  hooks:
    - TurnStart
    - SessionEnd
  actions:
    - probe-status
---

# Plugin Lifecycle Probe

Test-only package. Executable runtimes live under `runtimes/`.
