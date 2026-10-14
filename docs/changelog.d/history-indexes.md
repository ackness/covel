### Fixed

- **Long sessions no longer get slower on every turn because of how history is read.** SQLite and PostgreSQL now have indexes for the turn-message reads made on every turn: the prompt history, recent messages and the player-message count. They also have indexes for snapshots, and PostgreSQL gains the turn-result index SQLite already had. Pruning old auto snapshots is a single statement that no longer scans every session's snapshots. Existing databases get the new indexes at their next start.
