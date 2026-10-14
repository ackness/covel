### Fixed

- **Session labels and errors follow the interface language.** Canvas, storage, plugin failures, error badges and media jobs use translated text; punctuation and numbered labels are part of the translations.
- **Image generation shares the global confirmation queue.** Its authorization prompt no longer opens a separate dialog above another confirmation.
- **Forms without an interaction submission target show an error.** Their values remain editable instead of being sent as JSON chat text or marked submitted.
