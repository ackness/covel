### Added

- **Waiting shows safe response revision progress.** The host keeps runtime/tool progress, Stop and failure/retry controls accessible in plugin views, with a localized “Revising response” label after a rejected submission. Candidates and private review feedback stay out of story and sandbox state.

### Changed

- **Stories appear only after commit.** Chat, stage, copy/export and recovery use complete durable messages; failed or cancelled turns retain committed history without unsaved narrative drafts.
- **Breaking: session pages require bridge version 3.** Remove `streaming` reads and append-message handlers, consume complete `session.messages`, and update host and page together. Message ordinals follow durable IDs. Version 2 is rejected; existing committed messages remain valid. See the [session projection contract](../en/reference/ui-panels.md#sessionprojection-version-3).
