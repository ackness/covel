### Changed

- **Long tool conversations condense older output to stay within the model context.** The loop preserves full tool records, replaces old result data with omission markers, and freezes older steps into deterministic digests. Trimming starts only above the input limit and stops at 70% of it, so a request that fits, including a finalizer's, keeps its tool data. If the request still cannot fit, profiles allowing a finalizer get one answer request with tools off, whose trimming may also reach the newest tool step. Condensed results are matched to their calls by call metadata and content, so a hook that filters calls with reused IDs cannot swap one call's result for another's. Unrescued overflows retain their failure text and runtime fault attribution.

### Documentation

- **Context budgeting and finalizer rescue are documented together.** The protocol, prompt structure, execution flow, plugin options, API trace counters and glossary describe request-only trimming and context-overflow settlement in both languages.
