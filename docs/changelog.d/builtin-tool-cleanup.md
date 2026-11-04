### Breaking

- **Character writes use `sync-characters`.** `create-character`, `update-character` and `get-character-schema` are removed. Use the batch tool's creates/updates; functions read `ctx.world.characterSchema`, and agents receive type and field constraints through the session tool definition.
- **Agent suspensions declare `fields` instead of `resumeSchema`.** Use the `create-form` field objects; the framework compiles the stored answer schema. Function outcomes still accept raw JSON Schema.
- **Character misses are coded errors.** `get-character` throws `not-found` / `ambiguous`, and successful content is `{ character }` without `found`. `list-characters` rejects `null` and empty filters; `"none"` / `"all"` are literal type filters. Character record payloads need no conversion; recreate suspended development runs as described in the `submit-output` entry.

### Added

- **Event tool definitions advertise session contracts and typed payloads.** `emit-event` lists advertised topics as an enum and includes per-topic payload schemas, with local `$ref` / `$defs` expanded in place and inferred types added for strict model endpoints, including Kimi/Moonshot. A topic that cannot be described safely (a recursive, external or dangling reference) is omitted from the tool with a server warning and keeps its full schema in the event catalogue, so an optional event schema does not block the story. Unknown topics remain refused at execution time, and author schemas still control payload validation. See [`emit-event`](../en/reference/tools.md#emit-event).
- **Sub-agents can read characters.** `list-characters` and `get-character` are read-only, idempotent and safe for concurrent reads.

### Changed

- **Character batch errors identify the failing entry.** Coded errors retain the full correction text, and the character tracker can retry failed detail reads.
