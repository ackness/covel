### Added

- **Agent runtimes can choose a loop profile.** `agent.loop.profile` is `story`, `actor` or `system`, and `agent.loop.stream`, `steering`, `truncation`, `fallback` and `finalizer` override one behaviour at a time: showing text to the player as it streams, reading the player's interjections, keeping a reply cut at the output limit, what a repeated tool call does, and when the tools are turned off to ask for the answer. Without a profile, a runtime with `io.visibility: story` uses `story` and any other `system`. `actor` answers without tools when the model goes in circles, for agents that only answer a brief. Loading rejects a story profile, streaming or steering on a non-story runtime, and a `truncation: accept`, written or taken from the profile, without streaming. Rules: `docs/reference/plugins.md`.
- **An agent can finish before its time limit.** `agent.loop.finalizer.deadlineReserveMs` stops starting steps that many milliseconds before the deadline and asks for the answer with tools off, when text alone can complete the runtime. A written answer succeeds with stop reason `deadline` and `finalizer: true`. It is off (`0`) by default. Rules: `docs/reference/plugins.md`, `docs/reference/protocol.md`.

### Changed

- **The agent loop reads its behaviour from the loop profile instead of the output kind.** Existing runtimes keep their behaviour: story runtimes resolve to the `story` profile and every other agent to `system`, with no manifest change. `pnpm validate:plugin` warns about a loop key written with its profile's value. Flow: `docs/internals/flow.md`.
