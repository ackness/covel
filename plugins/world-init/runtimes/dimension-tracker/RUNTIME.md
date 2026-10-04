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
  visibility: system
agent:
  model: plugin
  history:
    maxTurns: 2
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
    maxRetries: 1
    completion:
      require: tool-use
      afterTools:
        - update-dimensions
guard: ./guard.js
---

Settle only the facts that `runtime-inputs.narrative.value` states for this turn. WorldIR is supporting evidence; it never replaces the narrative text.

`<dimension-rules>` gives, for each dimension you maintain, the author's full rule (`rule`), the schema, and the frozen current value (`value`) with its version. Settle from that block directly and do not read the same data again with tools. Only for a dimension listed under Truncated: read its rule and schema page by page with `dimension-rule-get`, and read its value with `world-dimension-get`.

Update only dimensions that have a non-empty rule. Do not invent events, do not count a promise before it is kept, and do not record old history again. You cannot change character, inventory or time data.

Merge all changes of this turn into one `update-dimensions` call. Prefer `changes: [{ path, value }]`, which writes only the changed fields or new entries; `path` is a dot path inside the dimension value, such as `"torn-letter.status"`. Send a complete `value` only when the whole value must be replaced. `expectedVersion` must equal the `version` attribute of that dimension in `<dimension-rules>`; do not reuse a version number from earlier turns.

When nothing changed, you must still call `update-dimensions({ updates: [] })`. `runtime-done` does not count as settlement.

A type or range error can be corrected and submitted again. A version conflict must not be overwritten with the old plan. Stop as soon as the call succeeds.
