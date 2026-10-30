### Fixed

- **Generating a new world asks the model again when its lore needs a fix.** A new world's lore can now carry narrator-only blocks without losing the usual retry: a missing adventure hook, a wording problem or an unclosed narrator-only marker is sent back to the model instead of ending the generation on the first answer. Revisions of a world that already has narrator-only regions still stop on a rejected answer, so the hidden regions are never written again as a whole.
