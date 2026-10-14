### Fixed

- **Opening a session no longer misses a background change committed at the same moment.** The session view now carries the event cursor of the moment it was read. The first live connection replays from it, or reads the session again when the connection opened later than the view, so a panel no longer shows an old value until the next change or reconnect.
