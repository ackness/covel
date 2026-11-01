### Added

- **Agents can delegate independent work concurrently with `delegate-batch`.** Ordered requests and indexed results share existing execution limits, cancellation, speculative world reads and write-service operation boundaries. Excess calls are refused immediately; private batches stay out of public traces.

### Changed

- **Dialogue Narrator follows parallel turn plans with bounded batch delegation.** Successful character contributions retain plan order. Sequential plans keep individual calls, missing or failed actors retain narrator-only fallback, and parallel dispatch does not reduce model-call or token costs.
