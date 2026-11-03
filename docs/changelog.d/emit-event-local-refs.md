### Fixed

- **Event payload schemas that use local `$ref` / `$defs` are now shown to the model in the `emit-event` tool.** The model-facing copy expands local references in place and drops the definitions, so these topics get a typed payload instead of a plain object plus a schema repeated in the prompt's event catalogue. Recursive, external or dangling references still leave the topic out of the tool and keep its full schema in the catalogue. Details: [tools](../reference/tools.md#emit-event).
