### Fixed

- **World and plugin translation no longer fails when a model miscopies a text's ID.** Each request now shows the model short numbers instead of IDs such as `characters/characters.json#[id=<UUID>].name`, and maps the answers back, so a character with a UUID ID translates like any other.
