### Added

- **A review can keep story drafts from players until it accepts them.** A `contributes.hooks` entry `{ event: ReviewAgentOutput, holdsDrafts: true }` makes the stories of every session that enables the plugin appear only once all reviews accepted the submission, so a rejected version, such as one that names a mystery's culprit early, is never shown. Stories still appear before later plugins run and the turn commits. The declaration grants no permission and `pnpm plugin:extract` keeps it. See [holding story drafts](../en/reference/hooks.md#holds-drafts).
