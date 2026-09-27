---
name: notes-workbench/save
description:
  zh: 保存原文记录，或先经指定格式化服务处理再保存。
  en: Save a raw note or format it through a selected provider before saving.
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
execution: sync
trigger: { type: manual }
---

Manual payload: `{ "text": "...", "providerPluginId": "optional-plugin-id" }`.
Returns `value.note`. Notes are stored in the package's `notes` namespace under
a UUID key. A selected provider must be currently discoverable under the
`examples/note-format@1` contract and expose `format-note`.
