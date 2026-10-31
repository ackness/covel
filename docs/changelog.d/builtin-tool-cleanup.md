### Breaking

- **Character writes use `sync-characters`.** `create-character`, `update-character` and `get-character-schema` are removed. Use the batch tool's creates/updates; functions read `ctx.world.characterSchema`, and agents receive type and field constraints through the session tool definition.
- **Agent suspensions declare `fields` instead of `resumeSchema`.** Use the `create-form` field objects; the framework compiles the stored answer schema. Function outcomes still accept raw JSON Schema.
- **Character misses are coded errors.** `get-character` throws `not-found` / `ambiguous`, and successful content is `{ character }` without `found`. `list-characters` rejects `null` and empty filters; `"none"` / `"all"` are literal type filters. No development data needs recreating. Stored suspensions and old tool calls in their transcripts remain resumable.

### Added

- **Event tool definitions advertise session contracts.** `emit-event` lists advertised topics as an enum and includes per-topic payload schemas. Unknown topics remain refused at execution time.
- **Sub-agents can read characters.** `list-characters` and `get-character` are read-only, idempotent and safe for concurrent reads.

### Changed

- **Runtime completion instructions explain when to finish.** `runtime-done` describes calling it last, recording nothing and ending after the response.
- **Character batch errors identify the failing entry.** Coded errors retain the full correction text, and the character tracker can retry failed detail reads.
