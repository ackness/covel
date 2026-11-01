### Changed

- **Standalone SillyTavern lorebooks resolve character tokens when imported with exactly one card.** Entry content, titles and literal keywords use the sanitized character name regardless of upload order. Embedded books retain their owner; standalone imports with no cards or multiple cards still remove and report unresolved character tokens. Existing worlds are unchanged; reimport into a new world to apply the rule. See [the import guide](../worlds/import-sillytavern.md).
