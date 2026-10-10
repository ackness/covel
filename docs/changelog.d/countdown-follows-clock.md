### Fixed

- **A countdown or deadline dimension now follows the world clock.** The dimension tracker (`world-init/dimension-tracker`) did not receive the world time, so a rule such as "minutes remaining is 09:14 minus the station clock" stayed at its start value on every turn in which the story text named no time, while the clock next to it moved. The tracker now reads the clock as settled for the current turn, and `update-dimensions` takes a `followsClock` list: in a turn in which the clock moved, a settlement that leaves out a dimension named there is refused with the clock in the message, so a turn in which nothing else happened no longer leaves the countdown where it was. The bundled world Emberback states its storm countdown as a function of that clock.

### Added

- **A post-turn runtime can read the time settled for the current turn.** `world-time/advance` publishes the contract `world-time-evolution@1` with a schema. Its `summary` holds the display text, the base unit, the time elapsed since the session started and the time elapsed in this turn. Bind it as an optional input with `select: /summary`; the binding also orders the consumer after the time settlement. Reference: `docs/reference/world-time.md`. For world authors: write the `updateRule` of a time-bound dimension as a function of the clock (`docs/reference/dynamic-dimensions.md`).
