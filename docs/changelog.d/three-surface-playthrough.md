### Fixed

- **Stage portraits no longer carry over from an earlier location.** Scene Stage clears existing direction actors before new-location cues, with matching preview and commit order.
- **Character creation echoes edited answers instead of hardcoded defaults.** Every collected field must retain its narrative placeholder before the form is shown.
- **Resuming a suspended turn updates the displayed player-turn count immediately.** Initiators reread the committed session clock, while observing clients refresh on `turn.resumed`; delayed reads cannot overwrite a later visit or newer committed state.
