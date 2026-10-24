### Fixed

- **Dice Check no longer rolls against health or trust in a world without abilities.** When the player character has no ranged number in the `abilities` category, the check rules use modifier 0 and report no attribute, instead of asking the narrative to invent a modifier from health or trust. Missing character data uses the same rule.
