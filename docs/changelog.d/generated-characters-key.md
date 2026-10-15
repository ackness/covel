### Changed

- **A generated world keeps its characters under one key.** The record of a world the generator made no longer repeats its characters in `metadata.characterBlueprints`; they are in `metadata.embeddedCharacters`, as for every other world. Worlds made by earlier builds already have both keys and keep working.
