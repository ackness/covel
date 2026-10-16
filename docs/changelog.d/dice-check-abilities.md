### Fixed

- **Dice checks no longer offer health or trust as a check attribute.** Dice Check listed every ranged number of the player character with its modifier, so the narrator could roll against health (80/100 → +8) or trust. It now lists only the `abilities` attributes, the same ones Tabletop Rules uses for point buy and its check panel. A world without ranged abilities gets no list, and the narrator converts the attribute itself as before.
- **Emberback's five attributes are all abilities.** Grit and Insight were `stats`, so the status bar showed them as bars, and Rapport was `social`. All five are check attributes from 0 to 5 and now sit in `abilities`. Sessions started earlier keep their old character schema.

### Documentation

- The world manifest reference, "Your first world" and the world generator's tool now say what each attribute `category` is for: `abilities` for checks and point buy, `stats` for status-bar bars, `social` for relationships.
