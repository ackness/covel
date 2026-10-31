### Changed

- **Long tool conversations condense older output to stay within the model context.** The loop preserves full tool records, replaces old result data with omission markers, and freezes older steps into deterministic digests. If the request still cannot fit, profiles allowing a finalizer get one answer request with tools off and all tool steps condensed. Unrescued overflows retain their failure text and runtime fault attribution.

### Documentation

- **Context budgeting and finalizer rescue are documented together.** The protocol, prompt structure, execution flow, plugin options, API trace counters and glossary describe request-only trimming and context-overflow settlement in both languages.
