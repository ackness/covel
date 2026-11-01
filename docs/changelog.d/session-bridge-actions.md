### Breaking

- **Session pages use public projection version 3 and a narrow handler map.** Replace raw pending blocks with public interactions and per-frame answer handles. Session pages no longer receive panel KV/context/jobs or action/command/event RPC handlers; only individually consented player actions, interaction answers, own manual runtimes, abort and own-panel navigation are available.

### Added

- **Ordinary session views can request player actions through the host.** Device-local consent binds every requested capability to the complete resolved content, including every published resource. Runtime writes retain normal approval, proposal validation and commit.

### Changed

- **Digest asset URLs verify actual bytes before success.** Same-size changes are refused before GET, HEAD or conditional cache responses. Session ports have bounded replay tracking and retire on navigation, content changes and revocation; mutations and approval grants recheck the lease after credential lookup, so late approvals and replies cannot authorize a new visit. Already dispatched work can still settle.

### Upgrade notes

- **Recreate bridge drafts and ports and update projection consumers.** No database or session reset is needed. Existing reading grants do not grant extra capabilities. Main/composer replacement and heartbeat recovery are not available in this change. The new third-party probe is version 0.1.0.
