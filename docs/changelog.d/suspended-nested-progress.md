### Fixed

- **Progress tasks reported by `ctx.recursiveCall` children now settle with the parent's commit.** They used to stay at their last reported state, because a nested call reported under a scope that no commit settled. While the parent is suspended they wait for input; a resumed parent's commit ends them with the result they were saved with; abandoning, expiring or replacing the suspension cancels them with the parent's tasks; and a failed parent's children no longer stay `running`. Rules: `docs/reference/plugins.md`, `docs/reference/api.md`.
