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

Pre-Game runtimes (priority ≤ 99) are framework-protected and never trimmed.

## Configuration

| Env                     | Default  | Meaning                                          |
| ----------------------- | -------- | ------------------------------------------------ |
| `COST_GATE_SOFT_TOKENS` | `150000` | Soft cap — start trimming background generation. |
| `COST_GATE_HARD_TOKENS` | `200000` | Hard cap — pause the turn.                       |

Thresholds are read lazily, so a deployment can change them without a restart.

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
