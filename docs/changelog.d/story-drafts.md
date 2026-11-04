### Added

- **Players read the story while it is written.** Story agents now show what they have written of `submit-output` as a draft before the turn commits: by default each part (a segment, or the whole narrative) appears once it is finished, and the committed story replaces the draft without being revealed again in the chat. A retry, a provider switch or a rejected submission retracts the draft first. Events: [draft events](../en/reference/protocol.md#draft-events).
- **Authors choose how fine drafts are.** `io.output.live` takes `units` (default for story agents), `text` (also the part being written) or `off`. Validation rejects it on function runtimes, `system` runtimes and `io.output.from`. See [story drafts](../en/reference/plugins.md#story-drafts).
- **Players choose how early to read.** Settings → General → "Show the story as it is written" offers as it is written, line by line (default) or once the turn is saved, and can only be more cautious than the author. See [settings](../en/reference/settings-store.md).

### Changed

- **A story is no longer hidden until its commit.** Before the commit it appears as an unreviewed draft on the stream of the action that started the turn; review and commit hooks still decide what becomes a message, and a hook that declares `holdsDrafts` keeps the draft back until it has accepted it. See [security](../en/internals/security.md).
