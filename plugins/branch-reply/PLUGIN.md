---
name: branch-reply
description:
  zh: 提供多条可切换的回复，让你挑选更合适的说法。
  en: Offers several reply options so you can choose the one that fits best.
pluginType: plugin
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: manual
capabilities:
  - branch-reply
  - prompt-history-rewriter
tags:
  - role:branching
  - cost:function
  - ui:message-block
  - ui:manual-action
ui:
  message:
    - ./ui/branch-reply-block.json
relations: {}
---

# Branch Reply

Manual function runtime for Covel-native swipe and regenerate storage.

## Manual payload

```json
{
  "action": "createCandidates",
  "turnId": "turn-123",
  "baseText": "I step closer and ask what happened.",
  "count": 3
}
```

```json
{
  "action": "acceptCandidate",
  "turnId": "turn-123",
  "candidateId": "turn-123-candidate-1"
}
```

## Behavior

1. Stores candidate sets under `plugin_data[branch-reply][turns][turnId]`
2. Stores message block state under `plugin_data[branch-reply][message][turnId]`
3. Emits proposal-backed writes through `withPendingProposals`
