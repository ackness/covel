### Fixed

- **Plugin author tests use current contracts.** Tool integration tests compile a valid manual function manifest; runtime case files reject misspelled fields and malformed expectations before execution, with file and field paths in errors (F-128, F-130).
- **New plugins start with matching versions.** Every scaffold mode sets both package and manifest versions to `0.1.0`, includes a runtime-case editor schema, and is covered by static validation (F-131).
