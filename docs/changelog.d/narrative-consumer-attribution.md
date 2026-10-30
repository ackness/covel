### Fixed

- **Fact, character, and dimension extraction retain narrative speakers and actors.** The bundled consumers select `narrative-engine@2` segments instead of flattened prose. WorldIR keeps its narrative-only evidence scope, including on a scoped retry; it does not recover player words absent from those segments. Prompts distinguish an NPC’s words or commitments from the player’s choices; story text and history are unchanged. These changes preserve evidence but do not guarantee model attribution accuracy. See `docs/reference/plugins.md` and `docs/builtin/world.md`.
