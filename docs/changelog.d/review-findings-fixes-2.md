### Fixed

- **Long sessions stay fast.** Checking which interactions are still unanswered no longer rescans the whole message log once per message. A session page's projection reads back only as far as its window instead of measuring the whole history, and the page boundary no longer re-validates a projection the host has just checked. Each auto-advance round reads only the messages since the player's last one, and reads past answers only when an interaction there needs them.
