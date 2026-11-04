### Added

- **`pnpm --filter @covel/ai-provider update-models-dev` refreshes the catalog snapshot.** Reasoning rules gain `format`, `thinksByDefault`, `toolChoiceWhileThinking`, `sampling` and `whenUnlisted`, `providers` (scope a rule to one provider) and `withTools` (limit the levels used with tools), in the bundled data and in the user's `reasoning-models.json`. Settings shows which level is sent by default and which sampling parameters a model ignores or fixes.

### Changed

- **Reasoning levels come from the models.dev catalog.** Covel bundles a trimmed snapshot of [models.dev](https://models.dev) and reads each model's levels, default level, fixed sampling parameters and accepted tool choices from it, per provider endpoint. Many models that showed no reasoning options before (Kimi K3, GLM 5.x, MiniMax, Gemma, Claude on Bedrock and Vertex, and others) now list them. Covel's own rules still win where they name a model, and still decide how each vendor switches thinking on and off.
- **A slow top default is stepped down when no level is chosen.** When a model's own default is its highest level and that level is `xhigh` or `max` (Kimi K3.1 Pro defaults to `max`), requests with no level chosen send the level below it. Choose "Provider default" to keep the model's own default.
- **Sampling a model fixes itself is no longer sent.** Temperature and Top P are left out for models the catalog marks as fixing them (GPT-5 and later, Kimi K3). The server logs one warning per model and parameter when a configured value is dropped.
- **Forced tool calls step back while a model thinks.** DeepSeek gets `tool_choice: "auto"` instead of a forced tool while thinking; Kimi K3 gets `required` instead of a named tool.

### Fixed

- **A model that always thinks uses its lowest level when a runtime turns reasoning off.** A model whose catalog entry says it always thinks now sends its lowest level (`low` for Kimi K3.1 Pro) instead of thinking at its highest; Kimi K3.1 Pro ran every call, including memory extraction, at `max` and the opening timed out.
- **Models named like `MiniMaxAI/...` are no longer taken for xAI models.**
