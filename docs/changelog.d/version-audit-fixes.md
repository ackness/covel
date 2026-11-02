### Fixed

- **Suspended agents with tool-sourced output can save snapshots and browser checkpoints.** The saved output contract retains its source tool so restoring and submitting does not repeat successful business work. See [agent completion](../en/reference/plugins.md#completion-conditions-agentcompletion).
- **Inventory batches with long descriptions no longer get counted twice.** The ledger uses retained service results when the operation request exceeds its size limit. See [Inventory](../en/builtin/rpg.md#inventory-inventory).
- **Successive character choices are saved in order, and switching saves does not block new input on an old character request.** Action submission waits only for its own session’s switches and displays the resulting actor. See [session seats](../en/reference/api.md#session-seats).
