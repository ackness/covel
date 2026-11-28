### Breaking

- **Stored session and browser checkpoint contracts now use schema versions 9 and 3.** Existing development databases and browser checkpoints from earlier versions must be recreated.

### Added

- **Turn branching now has shared storage records, branch-tree contracts, runtime materialization helpers, and initial session branch API routes.** The initial routes expose branch topology, node labels, subtree deletion, and a checkout integration point for the remaining transactional branch execution work.
