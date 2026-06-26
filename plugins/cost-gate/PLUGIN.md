---
name: cost-gate
description:
  zh: 给每局设置 token 花费上限：接近上限时自动减少后台生成，达到上限时暂停本回合。
  en: Caps token spend per session — trims background generation near the cap and pauses the turn at the cap.
pluginType: plugin
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: manual
capabilities:
  - cost-control
tags:
  - role:budget
  - cost:function
hooks:
  - event: PostLLMResponse
    handler: ./hooks/accumulate-usage.js
    enforce: post
  - event: PreSchedule
    handler: ./hooks/trim-downstream.js
  - event: TurnStart
    handler: ./hooks/enforce-cap.js
    enforce: pre
  - event: SessionEnd
    handler: ./hooks/cleanup.js
relations: {}
---

# Cost Gate

A cross-cutting, **opt-in** plugin that enforces a per-session token budget
entirely through lifecycle hooks. It has no schedulable runtime of its own —
the `function` runtime is `trigger: manual` and never runs; the no-op handler
exists only so the manifest is complete.

## How it works

| Hook                                | Role                                                                                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostLLMResponse` (`enforce: post`) | Accumulates every LLM call's `usage` into an in-process per-session counter. Runs last so it measures the final response. Pure observer — never rewrites the response.                                                      |
| `PreSchedule`                       | Once the session crosses the **soft** cap, narrows the turn's runtime set to story-output runtimes only (identified by `outputKind`, never by hardcoded id), skipping background LLM runtimes (codex / guide / extractors). |
| `TurnStart` (`enforce: pre`)        | Once the session reaches the **hard** cap, aborts the whole turn; the abort reason surfaces to the client.                                                                                                                  |
| `SessionEnd`                        | Drops the session's counter so the in-process map never leaks.                                                                                                                                                              |

Pre-Game runtimes (priority ≤ 99) are protected by the framework regardless,
so `PreSchedule` trimming only ever affects the main loop.

## Configuration

Hooks cannot read SettingsStore, so thresholds come from environment variables:

| Env                     | Default  | Meaning                                                       |
| ----------------------- | -------- | ------------------------------------------------------------- |
| `COST_GATE_SOFT_TOKENS` | `150000` | At/above this total, `PreSchedule` trims background runtimes. |
| `COST_GATE_HARD_TOKENS` | `200000` | At/above this total, `TurnStart` aborts the turn.             |

## Limitations

The counter is **in-process and non-persistent**:

- It resets on server restart.
- It is **not shared across processes**. On a single-process self-host (T1/T2)
  it is a true cap; on a multi-process / PostgreSQL deployment (T3) it is a
  per-process soft signal, not a global hard cap.

Enabling cost-gate for a session scopes all four hooks to that session only
(framework hook scoping). It is disabled by default — add `cost-gate` to a
world's plugin set or enable it per session to activate.
