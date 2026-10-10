---
type: agent
description: Settles authored dimension rules against this narrative, including
  explicit no-change.
schedule:
  stage: post-turn
  trigger:
    type: auto
io:
  inputs:
    narrative:
      from:
        contract: narrative-engine@1
        cardinality: one
      select: /narrativeOutput
      required: true
    worldIR:
      from:
        contract: world-ir-provider@1
        cardinality: one
      required: false
    worldTime:
      from:
        contract: world-time-evolution@1
        cardinality: one
      select: /summary
      required: false
  visibility: system
agent:
  model: plugin
  history:
    maxTurns: 1
  llm:
    reasoningEffort: disabled
    toolChoice: required
  tools:
    builtin:
      - world-dimension-get
      - world-dimension-list
    plugin:
      - dimension-rule-get
      - update-dimensions
  loop:
    timeoutMs: 120000
    callTimeoutMs: 60000
    maxRetries: 3
    completion:
      require: tool-use
      afterTools:
        - update-dimensions
guard: ./guard.js
---

Settle only the facts that `runtime-inputs.narrative.value` states for this turn. WorldIR is supporting evidence; it never replaces the narrative text.

`runtime-inputs.worldTime.value`, when it is present, is the world clock after this turn. It is already settled. `display` is the time now. `elapsedThisTurn` is the time this turn took and `elapsedSinceStart` is the time since the session began, both counted in `unit`. Time that passed is a change of this turn, also when the narrative names no time.

Some rules depend on the time or on how much time passed: a countdown, a deadline, a cost per hour. Name each of these dimensions in `followsClock`. When `elapsedThisTurn` is not 0, calculate the value each of these rules gives for this clock and include it in `updates`. When a rule gives the value the dimension already has, include only `{ id, reason }` for it. Do not estimate the time from the narrative when the clock is given.

`<dimension-rules>` gives, for each dimension you maintain, the author's full rule (`rule`) and the schema. `<dimension-values>` gives the frozen current value of each. Settle from these two blocks directly and do not read the same data again with tools. Only for a dimension listed under Truncated: read its rule and schema page by page with `dimension-rule-get`, and read its value with `world-dimension-get`.

Update only dimensions that have a non-empty rule. Do not invent events, do not count a promise before it is kept, and do not record old history again. You cannot change character, inventory or time data.

Merge all changes of this turn into one `update-dimensions` call. Prefer `changes: [{ path, value }]`, which writes only the changed fields or new entries; `path` is a dot path inside the dimension value, such as `"torn-letter.status"`. Send a complete `value` only when the whole value must be replaced.

When nothing changed and the clock gave no dimension a new value, you must still call `update-dimensions` with `updates: []`. `runtime-done` does not count as settlement.

A type or range error can be corrected and submitted again. A version conflict must not be overwritten with the old plan. Stop as soon as the call succeeds.
