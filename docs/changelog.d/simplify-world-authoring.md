### Breaking

- **`POST /api/ai/generate-world` takes `concept` only.** Clients must send `concept` instead of the removed `prompt` synonym. See `docs/reference/api.md`.
- **Generated world records no longer store `metadata.generatedPackageSummary`.** Clients must derive counts from `metadata.embeddedCharacters`, `metadata.embeddedLorebook` or the world package content.
