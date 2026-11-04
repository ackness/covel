### Added

- **Ordinary session views can request player actions through the host.** Device-local consent binds every requested capability to the complete resolved content, including every published resource. Runtime writes retain normal approval, proposal validation and commit.

### Changed

- **Digest asset URLs verify actual bytes before success.** Same-size changes are refused before GET, HEAD or conditional cache responses. Session ports have bounded replay tracking and retire on navigation, content changes and revocation; mutations and approval grants recheck the lease after credential lookup, so late approvals and replies cannot authorize a new visit. Already dispatched work can still settle.

### Upgrade notes

- **Reload session pages after upgrading.** No database or session reset is needed, and existing reading grants do not grant extra capabilities.
