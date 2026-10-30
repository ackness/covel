### Added

- **Scene Stage adds dialogue nameplates in chat.** Dialogue segments show the speaker's name and an avatar when available.

### Changed

- **Soundtrack and Scene Stage follow the story's cues.** Mood, scene, and presence updates commit with the story; explicit music and stage events remain overrides. Soundtrack follows scene cues without Scene Stage. Existing saved data keeps its shape and needs no recreation.

### Fixed

- **Switching the viewpoint keeps the new viewpoint character off stage.** Saved actors and cast selections no longer bypass the seat-based exclusion.
