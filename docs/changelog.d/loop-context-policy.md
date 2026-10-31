### Changed

- **Long tool conversations condense older output to stay within the model context.** The loop preserves full tool records, replaces old result data with omission markers, and freezes older steps into deterministic digests. If the request still cannot fit, profiles allowing a finalizer get one answer request with tools off and budget-triggered trimming that can include the newest tool step. Unrescued overflows retain their failure text and runtime fault attribution.

### Fixed

- **Finalizers retain tool data when the request fits.** Both normal and emergency trimming start only above the input limit and stop at the 70% target; emergency mode only expands which groups may be trimmed.
- **Hook filtering cannot substitute another call's condensed result when IDs are reused.** Ledger replay checks call metadata and result content, skipping missing or ambiguous matches.

### Documentation

- **Context budgeting and finalizer rescue are documented together.** The protocol, prompt structure, execution flow, plugin options, API trace counters and glossary describe request-only trimming and context-overflow settlement in both languages.
