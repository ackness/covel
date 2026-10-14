### Breaking

- **Agent completion and suspension follow the declared tools.** A `tool-use` runtime with `afterTools` must successfully call one of those tools; reads alone no longer satisfy completion, including after resume. Without `afterTools`, successful business tools still count. Completing-tool runtimes no longer receive automatic `runtime-done` authorization. Plugins that returned sentinel-shaped data from their own tools must instead declare and call `suspend` or `runtime-done` as appropriate. No stored-data migration is needed.

### Fixed

- **Repaired tool arguments remain valid in subsequent model requests.** History reflects JSON repairs and `PreToolUse` rewrites, including native provider continuations. Invalid arguments retain their original text and error result. Malformed-history rejections no longer trigger an unchanged retry (F-026).
- **Accepted tool results keep one terminal outcome.** Recording and completion traces follow result acceptance; telemetry failures only warn and preserve proposals. Later cancellation still aborts the enclosing runtime (F-146). Sentinel checks include the tool name (F-147), and declared completion tools govern the tool-use gate (F-150).
