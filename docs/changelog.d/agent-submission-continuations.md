### Changed

- **Agent resumes retain submission budgets and business work.** Suspensions save the admitted output contract, spent steps, correction ceilings and executor-owned results. Children use the same submission gate; successful computation still requires a successful commit before story publication or advancement. See [submission and resume](../en/reference/protocol.md#suspend-and-resume).
- **Recreate active agent continuations and snapshots/checkpoints containing them.** The continuation format removes saved prose and completing-tool answers without a migration. Existing committed story history remains valid. See [resume](../en/reference/api.md#post-apisessionsidsuspensionssuspensionidresume).
