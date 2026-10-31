### Added

- **Runtime world reads track their uncommitted producers.** Character and character-schema property reads share the existing dependency recorder across functions, skipped guards, tools and services. Host snapshot copies add no reads.

### Changed

- **Auxiliary world readers and their continuations follow rejected producers.** Their whole commit unit is discarded when an observed producer does not commit, including before saving a suspension. Story and setup readers remain protected and leave a structural trace. World visibility includes successful recursive children and excludes settled retry and detached seeds. No database rebuild is needed; recreate old pending suspensions when testing the new source-commit guarantee.
