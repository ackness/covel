### Fixed

- Character Traits reads the session character schema through the generic `session.characterSchema` panel source and updates after schema commits.
- Plugin state tables stay under `gameState.tables` and cannot overwrite World Model fields. Malformed dimensions show a local notice while the opening scene remains usable.
