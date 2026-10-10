### Changed

- **Forking a session is rate limited.** `POST /api/sessions/:id/fork` accepts at most 10 requests per minute for one parent session and client address, and answers `429 rate_limit_exceeded` beyond that.
- **`list-npc-graph` lists the most recently seen people first.** When the cap cuts the node list, the newest nodes stay and the result says how many were left out (`nodesTruncated`).
- **`create-form` no longer offers `submitBehavior.immediate`.** Nothing read it. A plugin that still passes it is not rejected; the key is ignored. The `char-creator` prompt no longer tells the model to send it.

### Fixed

- **An agent's output is checked against its `output.schema` again after a `PostRuntime` hook rewrites it,** as a function runtime's already was. A rewrite that breaks the schema fails the runtime with `output-schema-invalid` and commits nothing.
- **Mistport's faction relations no longer state Iron Meg's past as a Guild apprentice,** which the world keeps in its narrator-only section.

### Documentation

- `world-time` explains why a random time step derives from the turn instead of `ctx.random`.
- `chromium-dev` Playwright specs wait up to 20 seconds for an assertion, since the dev server transforms modules on first load.
