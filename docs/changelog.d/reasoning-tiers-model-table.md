### Added

- **A new model's reasoning levels can be added without a release.** A `reasoning-models.json` in the user configuration directory (`~/.covel/` on desktop, `COVEL_USER_CONFIG_DIR`) lists model name patterns and the levels they take; the server reads it at start, before the bundled entries. An invalid file is reported in the log and ignored. Format and an example: the reasoning level data section of `docs/reference/slots.md`.

### Changed

- **Which reasoning levels a model takes is data.** The model name checks that decided it are now entries in `packages/ai-provider/src/capability/reasoning-models.data.json`; the code only writes a selected level into each protocol's request. The levels offered and the fields sent are the same for every model name in the bundled tables (recorded in `packages/ai-provider/tests/__snapshots__/reasoning-characterization.snap.txt`, which the weekly model-table refresh re-records), apart from the fix below. A wire a plugin registers receives the matched level and the parameter form as `option` and `parameterStyle` in its `reasoningFields` request.

### Fixed

- **A Qwen model named with capital letters sends the level it was offered.** The offered levels were read from the lower-cased model ID and the request fields from the ID as written, so `Qwen/Qwen3.8-27B`, `Qwen3.8-Max`, `Qwen3.8-Flash` and `Qwen3.8-2.4T-A95B` on an aggregator sent `enable_thinking` without `reasoning_effort` for `low` / `medium` / `xhigh`, and the thinking-only `Qwen3-…-Thinking` models sent nothing for a level they do not offer where the lower-case name keeps thinking on. Thirteen names in the bundled table were affected.
