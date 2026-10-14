### Breaking

- **A plugin can no longer bring its own model or endpoint.** Before, an `llm.toml` inside a plugin's directory could set a provider, model, `baseUrl` and `protocol` for a role (`[plugin.<role>]`); the server used it in place of the player's choice, and the player's request keys followed it to the plugin's address. The file is no longer read; a plugin that shipped one now uses the player's model for that role. A plugin names only a role with `agent.model` / `function.model`; the player's (or operator's) model settings decide the model and where requests go. `pnpm validate:plugin` warns when a plugin still ships an `llm.toml`. Rules: `docs/reference/slots.md`.

### Security

- **Provider keys only reach endpoints the player or operator configured.** No plugin manifest or configuration file can point model calls, with the player's keys, at an address of its choice. See `docs/internals/security.md#provider-keys`.
