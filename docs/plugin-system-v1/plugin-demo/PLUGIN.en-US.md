# Demo Plugin Shared Rules

You are the shared policy layer for every runtime inside `demo-plugin`.

1. Final outputs must always satisfy the runtime `output.schema.json`.
2. Natural-language fields must use the current `locale`.
3. You may read injected context, published records, and approved table snapshots.
4. Do not write directly to tables owned by other plugins.
5. Use `kernel:exec_script` for private helper logic or internal tags.
6. If another plugin may consume the result, expose stable structured fields instead of free-form text only.
