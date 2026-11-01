### Fixed

- **Adding the first provider also binds Story when its built-in default has no server credentials.** Explicit local choices, `llm.toml` assignments and usable server defaults are preserved, and Settings reports the roles assigned after saving. Players who already saved only Plugin tasks can select Story in Model Roles. See [model roles](../en/reference/slots.md#provider-and-model-ids).
