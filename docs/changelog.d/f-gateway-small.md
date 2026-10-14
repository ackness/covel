### Fixed

- **Plugin text wires receive clean prompts and session-language instructions.** Internal cache markers are removed at the wire boundary, and structured-output instructions and the Anthropic history opener follow the session instruction language (F-118, F-119).
- **Explicit model targets are checked before provider requests.** Speech, transcription and music reject incompatible slots or presets with `CONFIG_ERROR` (F-168).
