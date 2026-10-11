### Breaking

- **The default first-token wait of a streamed agent call is shortened to leave room for the retries.** An agent that does not set `agent.loop.firstTokenTimeoutMs` no longer waits 120 seconds on every attempt: the last attempt may wait for all that is left of `timeoutMs`, and an earlier one for its equal share of it, or 60 seconds when the share is shorter, never more than half and never more than 120 seconds. With `timeoutMs: 120000` and `maxRetries: 3` the attempts wait 60, 30, 15 and 15 seconds. A runtime whose model sends its first output (text, reasoning or a tool call) later than that must set `firstTokenTimeoutMs`, which is used as written for every attempt, and a `timeoutMs` that fits it. Rule: `docs/reference/plugins.md`.

### Fixed

- **A model that accepts a request and then sends nothing no longer uses up an agent's whole time.** The first-token wait was 120 seconds, the same as the `timeoutMs` of the bookkeeping agents, so the retry that `maxRetries` allows was reported at the moment the runtime timed out and never ran. The wait is now bounded as described above, so a stream that stalls once is repeated and the runtime succeeds.
