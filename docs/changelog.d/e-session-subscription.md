### Fixed

- **Switching sessions no longer waits for another session’s action stream.** Subscription pauses belong to the session running the action (F-059).
- **Returning to a session reloads its UI slots without stale previews.** Departure and host cleanup release the previous session’s slot cache (F-061).
- **Recovery polling slows down during outages and pauses in hidden tabs.** Failure retries back off to 30 seconds, reset after success, and avoid a second HTTP retry loop (F-065).
