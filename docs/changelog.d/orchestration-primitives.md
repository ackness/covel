### Added

- **Plugins can compose stories from optional policies and character agents.** The SDK publishes `turn-policy@1` read-service and `character-actor@1` runtime contracts, canonical schemas, name-based model adapters and bounded witnessed-story history.
- **Sessions can choose a policy and cap delegation.** The plugin panel and owner-authorized orchestration API persist exact service choices and actor/call limits through snapshots, forks and checkpoints.

### Changed

- **Delegation budgets survive recursive work and suspension.** Atomic admission bounds total calls and distinct characters, including failed resumes and sibling continuations. New root executions have independent budgets.
- **Private actor results stay with the live orchestrator.** Intent and concealed delegation content are removed from persisted tools, traces and player projections while retaining model tool-call pairing. Public request traces also omit native continuations and reasoning after private delegation, and redact private steps in condensed context digests; the live model context remains unchanged.

### Upgrade notes

- **Recreate development continuations that ran delegated children without budget snapshots.** Discard unresolved suspensions that already ran children, and saved snapshots or checkpoints containing them, and re-record local dialogue/delegate model recordings whose model envelopes changed. Ordinary sessions, story messages, the database and worlds need no reset.
