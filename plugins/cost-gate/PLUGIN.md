---
name: cost-gate
displayName:
  zh: 花费上限
  en: Cost Gate
description:
  zh: 给每局设置 token 花费上限：接近上限时自动减少后台生成，达到上限时暂停本回合。
  en: Caps token spend per session — trims background generation near the cap and pauses the turn at the cap.
pluginType: plugin
outputKind: system
capabilities:
  - cost-control
tags:
  - role:budget
  - cost:function
entry: ./server/index.js
userSettings:
  - key: softTokens
    type: number
    min: 1000
    max: 10000000
    step: 1000
    label:
      zh: 软上限（token）
      en: Soft cap (tokens)
    description:
      zh: 本局累计 token 达到此值后，自动停掉后台生成，只保留主线叙事。留空则回退到 COST_GATE_SOFT_TOKENS 环境变量或默认 150000。
      en: Once the session's accumulated tokens reach this value, background generation is trimmed and only story output keeps running. Leave unset to fall back to the COST_GATE_SOFT_TOKENS env var or the 150000 default.
  - key: hardTokens
    type: number
    min: 1000
    max: 10000000
    step: 1000
    label:
      zh: 硬上限（token）
      en: Hard cap (tokens)
    description:
      zh: 本局累计 token 达到此值后，暂停本回合（abort）。应大于软上限。留空则回退到 COST_GATE_HARD_TOKENS 环境变量或默认 200000。
      en: Once the session's accumulated tokens reach this value, the turn is aborted. Keep it above the soft cap. Leave unset to fall back to the COST_GATE_HARD_TOKENS env var or the 200000 default.
---

# Cost Gate

A cross-cutting, **opt-in** plugin that enforces a per-session token budget
entirely through lifecycle hooks. It carries no schedulable runtime — its four
hooks are registered by its server entry (`server/index.js`).

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

Both thresholds are **per-session configurable**. The hooks read this plugin's
own resolved `userSettings` in-hook via `HookContext.getOwnSettings()`, so each
session / player can set its own budget from the Settings UI under
`Plugins > cost-gate`. The `userSettings` specs declare **no default on purpose**:
an unset field resolves to `undefined`, which is what makes the env-var fallback
below reachable (a declared default would always shadow the env). Leaving a field
blank therefore means "don't override — use the env var or hardcoded default".

| Setting (`userSettings`) | Meaning                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `softTokens`             | At/above this total, `PreSchedule` trims background runtimes. |
| `hardTokens`             | At/above this total, `TurnStart` aborts the turn.             |

Each threshold is resolved per hook invocation through a three-tier fallback
chain — **per-session `userSettings` → env var → hardcoded default** — so
existing deployments that set only the env (including a _custom_ env value) keep
working unchanged:

| Env (fallback)          | Default  | Used when the matching `userSettings` value is unset |
| ----------------------- | -------- | ---------------------------------------------------- |
| `COST_GATE_SOFT_TOKENS` | `150000` | falls back for `softTokens`                          |
| `COST_GATE_HARD_TOKENS` | `200000` | falls back for `hardTokens`                          |

Keep the soft cap **below** the hard cap: if the resolved soft cap `>=` the hard
cap, trimming has no window before the hard cap aborts the turn (cost-gate logs
a one-time warning in that case).

## Limitations

The counter is **in-process and non-persistent**:

- It resets on server restart.
- It is **not shared across processes**. On a single-process self-host (T1/T2)
  it is a true cap; on a multi-process / PostgreSQL deployment (T3) it is a
  per-process soft signal, not a global hard cap.

Enabling cost-gate for a session scopes all four hooks to that session only
(framework hook scoping). It is disabled by default — add `cost-gate` to a
world's plugin set or enable it per session to activate.
