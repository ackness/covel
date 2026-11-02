### Fixed

- **Character creation no longer ends setup before the player answers the form.** An agent submission whose `preGameDone` and `completion` contradict each other (`false` with `"done"`, or `true` with `"pending"`) is now rejected as a correctable `submit-output` error instead of counting as completion. Character Creator's opening agent also declares an output schema that only allows a pending setup, so the player character is always created from the submitted form before the opening runs. See [plugin reference](../en/reference/plugins.md#agent-output).
- **A public output contract error can be corrected inside the agent loop.** When an agent declares both a private `io.output.schema` and a public `io.output.contract`, the business value is checked against the contract before review; a mismatch comes back as a tool result the model can fix, instead of failing the runtime after the loop. See [plugin reference](../en/reference/plugins.md#hooks-that-rewrite-results-and-schema-checks).
- **Quotes inside an NPC's line no longer trigger a narration perspective correction.** In a dialogue segment that names its speaker, words that start unquoted are that speaker's speech, so a quotation inside them (They called it "temporary storage") or a Chinese 『』 quotation is not read as narration. Narration around a quote, such as `"Let's go," I say.` or `I say: "Let's go."`, is still checked.

### Changed

- **Story and actor agents get two output repairs instead of one.** The `story` and `actor` loop profiles now default to `corrections.outputRepair: 2`; `system` stays at 1. A model that first answers in plain prose and then sends cut-off submission JSON can still finish the turn instead of losing it. Authors can still set the value per runtime. See [loop profiles](../en/reference/plugins.md#agent-loop-profiles).

### Documentation

- **The agent submission check order is documented for story and system agents.** The plugin reference no longer says story agents skip the private schema check; it lists schema, story invariants, completion fields, public contract and review in the order the host applies them.
