### Added

- **Hooks that rewrite stories can hold story drafts too.** `holdsDrafts` is now accepted on `PostLLMResponse` (the story appears once every review accepts it) and `PostRuntime` (it appears only after the commit, since `replace.result` can still replace an accepted story), as well as `ReviewAgentOutput`. See [Holding story drafts](../en/reference/hooks.md#holds-drafts).

### Fixed

- **A story draft no longer lingers after the connection drops.** When the action stream ended without its final event, the draft stayed beside the recovered story, and the stage kept reading it.
- **A retried story shows its draft in the chat.** A retry's draft carried the retry's own turn and never appeared under the turn it retries.
- **Skipping ahead on the stage shows the whole draft.** Escape or "Show all" while a story was being written fell back to the previous story until the commit.
- **The stage reads the latest turn's draft** when an older one is still listed.
- **A draft that reuses a retracted id is no longer lost on a slow connection.** It was written before the retraction of the same id, which then wiped it.
- **An unapproved community review no longer holds drafts.** Its hooks do not run until the player approves them, so its `holdsDrafts` declaration now waits as well.
- **Streaming a long story costs less on the server.** Finished draft parts are kept instead of being rebuilt and serialized for every fragment.
