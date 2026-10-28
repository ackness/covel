### Fixed

- **The Core Memory panel shows when a block changed as a short local date and time.** It showed the raw ISO timestamp, such as `2026-10-28T09:15:00.000Z`; the stored value is unchanged.
- **Memory extraction no longer sends the model a turn ID inside a form ID.** The prompt section for the player's latest form now holds only the values the player entered, still marked as data that may belong to an earlier turn. It used to include the whole submission, so a form ID such as `tabletop-rules-check-<turn ID>` reached the model.
