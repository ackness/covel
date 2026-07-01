---
name: branch-reply
displayName:
  zh: 回复变体
  en: Reply Variants
description:
  zh: 提供多条可切换的回复，让你挑选更合适的说法。
  en: Offers several reply options so you can choose the one that fits best.
pluginType: plugin
runtimeType: function
outputKind: system
priority: 700
handler: ./handler.js
trigger:
  type: auto
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

Function runtime for Covel-native swipe + regenerate storage. Runs two ways:

- **Auto seed** (`trigger: auto`, priority 700 — after the narrative engines):
  with no `manualPayload`, it reads the active story engine's `narrativeOutput`
  from `completedResults` (engine-agnostic — discovered by the non-empty
  `narrativeOutput` contract, never by plugin id, so it works under `narrator`
  or `chat-mode-narrator`) and seeds candidate[0] with that reply. This is what
  makes the `ui.message` block appear — the block only renders once its
  `message` namespace is populated, so seeding is mandatory bootstrap. The seed
  is idempotent per `turnId` and no-ops on empty / system turns.
- **Manual** (`POST /api/sessions/:id/plugin-rpc` with `runtimeId: branch-reply`):
  the `createCandidates` / `acceptCandidate` actions below. `createCandidates`
  (Regenerate) calls the fast text slot through `ctx.gateway` to produce 1-2
  genuine alternative phrasings in the session locale; when no gateway/slot is
  available it returns the original only (it never fabricates filler).

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
