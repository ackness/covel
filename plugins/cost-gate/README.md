# @covel/plugin-cost-gate

Per-session token-budget guard. **Opt-in, disabled by default.**

cost-gate is a cross-cutting framework-capability plugin: it carries no
schedulable runtime and writes nothing to the store. It enforces a budget
entirely through four lifecycle hooks declared in `PLUGIN.md`.

## Behaviour

| Hook              | Effect                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostLLMResponse` | Adds each LLM call's `usage` (input + output tokens) to an in-process per-session counter. `enforce: post` so it measures the final, post-rewrite response.                     |
| `PreSchedule`     | At/above the **soft** cap, narrows the turn to story-output runtimes only (`outputKind === "story"`), skipping background LLM runtimes (codex / guide / extractors / trackers). |
| `TurnStart`       | At/above the **hard** cap, aborts the turn with reason `cost-gate: session token budget exhausted`. `enforce: pre` so it vetoes earliest.                                       |
| `SessionEnd`      | Drops the session's counter (no cross-session leak).                                                                                                                            |

While `session.phase === "setup"`, `stage: setup` runtimes are framework-protected and never trimmed — `PreSchedule` narrowing only affects the main loop.

## Configuration

Both thresholds are **per-session configurable** via `userSettings`. The hooks
read this plugin's resolved settings in-hook through
`HookContext.getOwnSettings()` (the runtime hook pipeline injects a frozen
snapshot of the manifest defaults merged with the player's saved values), so
each session / player can set its own budget from the Settings UI under
`Plugins > cost-gate`.

| Setting (`userSettings`) | Default  | Meaning                                          |
| ------------------------ | -------- | ------------------------------------------------ |
| `softTokens`             | `400000` | Soft cap — start trimming background generation. |
| `hardTokens`             | `600000` | Hard cap — pause the turn.                       |

Each threshold is resolved per hook invocation through a three-tier fallback
chain — **per-session `userSettings` → env var → hardcoded default**. The env
vars below remain a deployment-wide fallback so installs that set only the env
keep working unchanged:

| Env (fallback)          | Default  | Falls back for |
| ----------------------- | -------- | -------------- |
| `COST_GATE_SOFT_TOKENS` | `400000` | `softTokens`   |
| `COST_GATE_HARD_TOKENS` | `600000` | `hardTokens`   |

Settings and env are read lazily (per call), so a deployment can change either
without a restart. Keep the soft cap **below** the hard cap: if the resolved
soft cap `>=` the hard cap, trimming has no window before the hard cap aborts
the turn (cost-gate logs a one-time warning in that case).

## Limitations

The counter is **in-process and non-persistent**:

- resets on server restart;
- not shared across processes. Single-process self-host (T1/T2) gets a true
  cap; a multi-process / PostgreSQL deployment (T3) gets a per-process soft
  signal, not a global hard cap. For a global cap on T3, back the counter with
  a shared store (future work).

## Enabling

cost-gate ships in the built-in **Low Cost** plugin pack, so choosing that pack
in the prep screen enables it by default. You can also add `cost-gate` to a
world's plugin set or enable it per session via
`POST /api/sessions/:id/plugins/enable`. Its hooks scope to that session only
(framework hook scoping); other sessions are unaffected.

## Tests

```bash
pnpm --filter @covel/plugin-cost-gate test
```
