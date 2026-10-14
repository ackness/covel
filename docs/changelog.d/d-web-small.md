### Fixed

- **World revisions can be cancelled while running.** The request stays available for editing and retry, and late events from the cancelled request are ignored.
- **Unsaved world dimension drafts are protected on cancel and reload.** Discarding edits asks for confirmation, including incomplete form input and unapplied JSON. Successful saves clear the saved drafts' warning; failed saves keep it.
- **Panel providers use the same naming rule in every group.** Provider buttons show the plugin's localized name or ID, with no special treatment for `chat-mode`. Browser world saves also stop interpreting the removed `characterBlueprintSources` manifest field inside opaque metadata.
