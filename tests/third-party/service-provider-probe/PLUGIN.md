---
id: service-provider-probe
kind: plugin
displayName:
  zh: 服务提供测试插件
  en: Service Provider Probe
description:
  zh: 为第三方插件组合测试提供纯函数格式化服务。
  en: Provides a pure note formatting service for third-party composition tests.
entry: ./server/index.js
contributes:
  services:
    - probe.note-format@1
---

# Service Provider Probe

Test-only entry package. It has no runtime or UI.
