# History Compaction

This core plugin supplies the default `history.compact@1` extension. It protects recent dialogue, selects older messages, and merges them with the prior rolling summary using the host's completion adapter.

The kernel decides when history exceeds the available budget, validates the returned source message IDs, and persists the summary and message tags in one transaction. Source messages remain available for inspection and snapshots. The plugin owns the summary prompts and selection policy, and does not write storage directly.

An explicit provider of the same contract replaces this default. Disabling the plugin removes its compaction policy; ordinary context budget pruning remains a kernel operation.

Run `pnpm --filter @covel/plugin-history-compaction test` for the policy tests. Host admission, output validation, and transactional persistence are covered by the context and server compactor suites.
