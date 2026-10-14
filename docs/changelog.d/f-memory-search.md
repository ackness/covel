### Fixed

- **Memory search keeps distinct hits and returns the relevant passage.** Vector recall and keyword top-ups deduplicate by message ID; vector recall and archival use the same query-centered excerpts as keyword search. The tool preserves these excerpts and describes queries without assuming a keyword-only backend (F-154, F-155).
