### Changed

- **Sub-agents read the caller’s visible world at admission.** Tools and services share an isolated snapshot including upstream and own pending world writes. Only successful child reads join the caller’s commit dependencies; failed children discard reads and operations. Plugin KV and recursive execution boundaries remain separate. Recreate unresolved development suspensions/checkpoints when testing this attribution guarantee; existing sessions need no reset.
- **Character proposal author types include aliases.** The public SDK accepts both `aliases` and `removeAliases` on character upserts, matching the existing kernel contract.
