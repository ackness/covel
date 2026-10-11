### Added

- **Point the built-in model at any provider with `DEFAULT_*` variables.** Without an `llm.toml`, the server and the runtime test harness used a DeepSeek `story` slot that nothing could change. Setting `DEFAULT_BASE_URL` (an OpenAI-compatible endpoint), `DEFAULT_MODEL` and `DEFAULT_API_KEY` now sends that slot to your own provider; left unset, it stays DeepSeek. The recorded sessions under `tests/llm-replay/` use the same variables: `pnpm e2e:replay --record` records from `DEFAULT_BASE_URL` with `DEFAULT_API_KEY`, and `--upstream` is optional.

### Fixed

- **`pnpm e2e:replay` no longer hangs after a session.** When the test server was stopped by a signal, the command waited forever for it to exit.
