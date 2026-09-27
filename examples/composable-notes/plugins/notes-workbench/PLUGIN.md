---
name: notes-workbench
displayName: { zh: 记录工作台, en: Notes Workbench }
description:
  zh: 保存会话记录，并按需调用已启用的记录格式化插件。
  en: Save session notes and optionally format them through an active note provider.
pluginType: plugin
entry: ./server/index.js
commands:
  - name: notes
    description: { zh: 打开记录面板, en: Open the notes panel }
    action: open-notes
dataSchemas:
  notes:
    schemaVersion: 1
    acceptsWorldData: false
    schema: ./schemas/note.schema.json
    description: Notes saved by this plugin in the current session.
ui:
  right: [./ui/panel.json]
---

# Composable Notes Workbench

`/notes` opens the panel. The `providers` manual runtime lists active services
implementing `examples/note-format@1`. The `save` manual runtime saves raw text
or calls the explicitly selected provider before committing a note. Provider
failures never save a partially formatted note.
