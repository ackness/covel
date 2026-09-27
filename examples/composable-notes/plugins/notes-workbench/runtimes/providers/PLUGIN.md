---
name: notes-workbench/providers
description:
  zh: 列出当前会话可用的记录格式化服务。
  en: List note formatting services available to this session.
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
execution: sync
trigger: { type: manual }
---

Returns `value.providers` as a sorted array of active `format-note` services.
