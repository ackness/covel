### Added

- **Strict tool submission can use an explicitly verified target profile.** The generated output tool opts in only when its unchanged schema is compatible with the actual provider, model, protocol and endpoint. Unknown support stays off; host validation remains authoritative. See [tool submission capabilities](../en/reference/slots.md#tool-submission-capabilities).

### Changed

- **Tool-less targets fail before agent submission.** Configured same-tag fallbacks are checked individually. Submission-only requests can replace a named business-tool default while preserving capability-driven thinking controls, and agent schemas no longer request JSON-content formatting. Internal argument activity and terminal refusal boundaries are retained.
