### Fixed

- **The "memory could not be condensed" notice now appears when compaction keeps failing.** The count of failed attempts in a row was kept per request for requests that send their own model settings, so it restarted at 0 every turn and the notice never appeared. The count now lasts for the server process and is cleared when a session ends or is deleted. The notice no longer names a plugin; it asks the player to disable the plugin that condenses old turns.
