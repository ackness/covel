### Breaking

- **UI render blocks require `parts`.** The `{ type, ...content }` single-block shape is no longer accepted. Tools and handlers must send `{ parts: [...] }`; recreate development sessions containing uncommitted effects in the old shape. See `docs/reference/tools.md`.
- **Form fields require `name`.** The submission handler no longer accepts `id` as an alias. Update field definitions and recreate development sessions with pending forms that use only `id`.
