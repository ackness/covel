### Changed

- **Trace "slow" warnings use a threshold per event type.** A model response is flagged at 20 s, a runtime or function at 30 s, and a tool call or plugin fetch at 5 s, instead of one shared 1 s threshold that marked nearly every model call as slow. Each warning still carries its `thresholdMs`. Details: [API](../en/reference/api.md).
