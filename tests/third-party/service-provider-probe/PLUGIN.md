---
id: service-provider-probe
kind: plugin
displayName: Service Provider Probe
description: Provides a pure note formatting service for third-party composition tests.
entry: ./server/index.js
contributes:
  services:
    - probe.note-format@1
---

# Service Provider Probe

Test-only entry package. It has no runtime or UI.
