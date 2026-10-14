### Fixed

- SQLite saves can be deleted when the optional vector extension cannot load, even in databases with existing vector indexes. Orphan vectors are reclaimed when the extension next loads successfully (F-017).
- Concurrent startups cannot both take over a stale SQLite database lock. Takeover is serialized, uses a rename and an ownership read-back check, and counts relative and absolute paths as the same lock (F-113).
