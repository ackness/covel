### Fixed

- **Plugin random ranges behave the same in tests and games.** `makeRandom().int(min, max)` and seeded or unseeded `ctx.random.int` share argument checks and `RangeError` messages. Equal bounds, fractional bounds, and ranges whose width is at least `2 ** 48` are rejected everywhere (F-128).
