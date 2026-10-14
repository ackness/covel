### Fixed

- **Native EventSource reconnects resume missed events.** The subscription stream accepts `Last-Event-ID` as well as the existing query cursor, with the query parameter taking precedence. Stale header cursors receive the same reset response.
